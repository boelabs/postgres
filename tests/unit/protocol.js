import * as p from "../../src/protocol.js";
import { t } from "../test.js";

const hex = (x) => Buffer.from(x).toString("hex");
const str = (x) => Buffer.from(`${x}\0`);
const i16 = (x) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(x);
  return b;
};
const i32 = (x) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(x);
  return b;
};
const msg = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), i32(body.length + 4), body]);
};

t("Sync, Flush, Terminate, CopyDone", () => [
  hex(Buffer.concat([msg("S"), msg("H"), msg("X"), msg("c")])),
  hex(Buffer.concat([p.Sync(), p.Flush(), p.Terminate(), p.CopyDone()])),
]);

t("Query", () => [hex(msg("Q", str("select 1"))), hex(p.Query("select 1"))]);

t("Parse unnamed without types", () => [
  hex(msg("P", str(""), str("select 1"), i16(0))),
  hex(p.Parse("", "select 1", [])),
]);

t("Parse named with types", () => [
  hex(msg("P", str("s1"), str("select $1, $2"), i16(2), i32(23), i32(0))),
  hex(p.Parse("s1", "select $1, $2", [23, 0])),
]);

t("Bind with text values and null", () => [
  hex(
    msg(
      "B",
      str(""),
      str("s1"),
      i16(0),
      i16(3),
      i32(2),
      Buffer.from("42"),
      i32(-1),
      i32(0),
      i16(0)
    )
  ),
  hex(p.Bind("", "s1", [Buffer.from("42"), null, Buffer.alloc(0)])),
]);

t("Bind accepts strings and measures utf8 bytes", () => [
  hex(
    msg(
      "B",
      str("c1"),
      str(""),
      i16(0),
      i16(1),
      i32(4),
      Buffer.from("æø"),
      i16(0)
    )
  ),
  hex(p.Bind("c1", "", ["æø"])),
]);

t("Bind with parameter and result formats", () => [
  hex(
    msg(
      "B",
      str(""),
      str("s2"),
      i16(1),
      i16(1),
      i16(1),
      i32(1),
      Buffer.from([1]),
      i16(2),
      i16(0),
      i16(1)
    )
  ),
  hex(p.Bind("", "s2", [Buffer.from([1])], [1], [0, 1])),
]);

t("Describe statement and portal", () => [
  hex(
    Buffer.concat([
      msg("D", Buffer.from("S"), str("s1")),
      msg("D", Buffer.from("P"), str("")),
    ])
  ),
  hex(Buffer.concat([p.Describe("S", "s1"), p.Describe("P", "")])),
]);

t("Execute unnamed and named with a row limit", () => [
  hex(
    Buffer.concat([msg("E", str(""), i32(0)), msg("E", str("c1"), i32(100))])
  ),
  hex(Buffer.concat([p.Execute("", 0), p.Execute("c1", 100)])),
]);

t("Close portal and statement", () => [
  hex(
    Buffer.concat([
      msg("C", Buffer.from("P"), str("c1")),
      msg("C", Buffer.from("S"), str("s1")),
    ])
  ),
  hex(Buffer.concat([p.Close("P", "c1"), p.Close("S", "s1")])),
]);

t("CopyData and CopyFail", () => [
  hex(Buffer.concat([msg("d", Buffer.from("1,a\n")), msg("f", str("stop"))])),
  hex(Buffer.concat([p.CopyData(Buffer.from("1,a\n")), p.CopyFail("stop")])),
]);

t("Startup has no type byte and ends with an empty name", () => {
  const body = Buffer.concat([
    i32(196_608),
    str("database"),
    str("d"),
    str("user"),
    str("u"),
    Buffer.from([0]),
  ]);
  return [
    hex(Buffer.concat([i32(body.length + 4), body])),
    hex(p.Startup({ database: "d", user: "u" })),
  ];
});

t("SSLRequest and CancelRequest", () => [
  hex(
    Buffer.concat([
      i32(8),
      i32(80_877_103),
      i32(16),
      i32(80_877_102),
      i32(1234),
      i32(-5),
    ])
  ),
  hex(Buffer.concat([p.SSLRequest(), p.Cancel(1234, -5)])),
]);

t("Password, SASL initial response and SASL response", () => [
  hex(
    Buffer.concat([
      msg("p", str("secret")),
      msg("p", str("SCRAM-SHA-256"), i32(12), Buffer.from("n,,n=*,r=abc")),
      msg("p", Buffer.from("c=biws,r=abc")),
    ])
  ),
  hex(
    Buffer.concat([
      p.Password("secret"),
      p.SASL("SCRAM-SHA-256", "n,,n=*,r=abc"),
      p.SASLResponse("c=biws,r=abc"),
    ])
  ),
]);

const stream = Buffer.concat([
  msg("1"),
  msg("T", i16(1), str("x"), i32(0), i16(0), i32(23), i16(4), i32(-1), i16(0)),
  msg("D", i16(1), i32(1), Buffer.from("1")),
  msg("C", str("SELECT 1")),
  msg("Z", Buffer.from("I")),
]);

const collect = (chunks) => {
  const out = [];
  const frames = p.Frames((type, buffer, start, end) =>
    out.push(String.fromCodePoint(type) + (end - start))
  );
  for (const x of chunks) {
    frames.push(x);
  }
  return out.join(",");
};

t("Frames splits one chunk into messages with their full length", () => [
  "15,T27,D12,C14,Z6",
  collect([stream]),
]);

t("Frames gives the same messages for every two-way split", () => {
  const expected = collect([stream]);
  for (let i = 1; i < stream.length; i += 1) {
    const got = collect([stream.subarray(0, i), stream.subarray(i)]);
    if (got !== expected) {
      return [expected, `${got} (split at ${i})`];
    }
  }
  return [expected, expected];
});

t("Frames handles one byte at a time", () => [
  collect([stream]),
  collect([...stream].map((x) => Buffer.from([x]))),
]);

t(
  "Frames on a shared read buffer keeps what it has not framed when paused, and what comes while paused",
  () => {
    const expected = collect([stream]);
    const shared = Buffer.alloc(stream.length);
    const out = [];
    const frames = p.Frames((type, buffer, start, end) => {
      out.push(String.fromCodePoint(type) + (end - start));
      if (type === 84) {
        frames.pause();
      }
    }, true);
    const read = (from, to) => {
      stream.copy(shared, 0, from, to);
      frames.push(shared.subarray(0, to - from));
      shared.fill(0);
    };
    read(0, 20);
    read(20, 40);
    read(40, stream.length);
    frames.resume();
    return [expected, out.join(",")];
  }
);

t(
  "Frames owning a shared read buffer hands over messages that stay intact after the buffer is reused",
  () => {
    const shared = Buffer.alloc(stream.length);
    const kept = [];
    const frames = p.Frames((type, buffer, start, end) => {
      if (frames.owns(buffer)) {
        kept.push(buffer.subarray(start, end));
      }
      if (type === 49) {
        frames.own(true);
      }
    }, true);
    const read = (from, to) => {
      stream.copy(shared, 0, from, to);
      frames.push(shared.subarray(0, to - from));
      shared.fill(0);
    };
    read(0, 7);
    read(7, 20);
    read(20, stream.length);
    frames.own(false);
    return [hex(stream.subarray(5)), kept.map(hex).join("")];
  }
);

t("Frames hands over the whole message buffer", () => {
  let got;
  p.Frames((type, buffer, start, end) => {
    if (type === 67) {
      got = buffer.toString("utf-8", start + 5, end - 1);
    }
  }).push(stream);
  return ["SELECT 1", got];
});

t("Frames pauses mid-chunk and resumes without a new push", () => {
  const out = [];
  const frames = p.Frames((type) => {
    out.push(String.fromCodePoint(type));
    if (type === 84) {
      frames.pause();
    }
  });
  frames.push(stream);
  const paused = out.join("");
  frames.resume();
  return ["1T|1TDCZ", `${paused}|${out.join("")}`];
});

const decode = (fn, x) => fn(x, 0, x.length);

t("Decode ErrorResponse fields", () => {
  const e = decode(
    p.error,
    msg(
      "E",
      Buffer.from("SERROR\0"),
      Buffer.from("VERROR\0"),
      Buffer.from("C42601\0"),
      Buffer.from('Msyntax error at or near "selec"\0'),
      Buffer.from("P1\0"),
      Buffer.from("RscannerYYerror\0"),
      Buffer.from([0])
    )
  );
  return [
    'ERROR|42601|syntax error at or near "selec"|1|scannerYYerror',
    [e.severity, e.code, e.message, e.position, e.routine].join("|"),
  ];
});

t("Decode ErrorResponse with the severity only in the S field", () => {
  const e = decode(
    p.error,
    msg(
      "E",
      str("SFATAL"),
      str("C08P01"),
      str(
        "Mserver login has been failing, try again later (server_login_retry)"
      ),
      Buffer.from([0])
    )
  );
  return [
    "FATAL|FATAL|08P01",
    [e.severity, e.severity_local, e.code].join("|"),
  ];
});

t("Decode RowDescription", () => {
  const columns = decode(
    p.rowDescription,
    msg(
      "T",
      i16(2),
      str("id"),
      i32(16_384),
      i16(1),
      i32(23),
      i16(4),
      i32(-1),
      i16(0),
      str("name"),
      i32(16_384),
      i16(2),
      i32(25),
      i16(-1),
      i32(-1),
      i16(0)
    )
  );
  return [
    "id:16384:1:23,name:16384:2:25",
    columns.map((x) => [x.name, x.table, x.number, x.type].join(":")).join(","),
  ];
});

t("Decode ParameterDescription", () => [
  "23,25,0",
  decode(
    p.parameterDescription,
    msg("t", i16(3), i32(23), i32(25), i32(0))
  ).join(","),
]);

t("Decode CommandComplete", () => [
  "INSERT:3|SELECT:5|BEGIN:null|CREATE TABLE:null|COPY:2",
  ["INSERT 0 3", "SELECT 5", "BEGIN", "CREATE TABLE", "COPY 2"]
    .map((x) => decode(p.commandComplete, msg("C", str(x))))
    .map((x) => `${x.command}:${x.count}`)
    .join("|"),
]);

t("Decode ReadyForQuery status", () => [
  "ITE",
  ["I", "T", "E"]
    .map((x) => decode(p.readyForQuery, msg("Z", Buffer.from(x))))
    .join(""),
]);

t("Decode NotificationResponse", () => {
  const x = decode(
    p.notification,
    msg("A", i32(42), str("chan"), str("hello"))
  );
  return ["42:chan:hello", [x.pid, x.channel, x.payload].join(":")];
});

t("Decode ParameterStatus and BackendKeyData", () => {
  const [name, value] = decode(
    p.parameterStatus,
    msg("S", str("TimeZone"), str("UTC"))
  );
  const key = decode(p.backendKeyData, msg("K", i32(99), i32(-7)));
  return ["TimeZone=UTC 99/-7", `${name}=${value} ${key.pid}/${key.secret}`];
});

t(
  "A message that fails to encode leaves nothing behind for the next one",
  () => {
    const bad = {
      toString() {
        throw new Error("wat");
      },
    };
    let message;
    try {
      // A parameter is written before the one that fails.
      p.Startup({ database: "a", user: bad });
    } catch (error) {
      ({ message } = error);
    }
    return [
      `wat ${p.Sync().toString("hex")}`,
      `${message} ${p.Sync().toString("hex")}`,
    ];
  }
);

t(
  "Column table oids, numbers and type oids are read unsigned, as in v3",
  () => {
    const name = Buffer.from("a\0");
    const body = Buffer.alloc(2 + name.length + 18);
    body.writeUInt16BE(1, 0);
    name.copy(body, 2);
    body.writeUInt32BE(0xff_ff_ff_f0, 2 + name.length);
    body.writeUInt16BE(0xff_ff, 6 + name.length);
    body.writeUInt32BE(0x80_00_00_01, 8 + name.length);
    const x = Buffer.concat([Buffer.from("T"), Buffer.alloc(4), body]);
    x.writeInt32BE(body.length + 4, 1);
    const [c] = p.rowDescription(x, 0, x.length);
    return [
      "4294967280 65535 2147483649",
      [c.table, c.number, c.type].join(" "),
    ];
  }
);

t("A parameter type oid above 2^31 is written as its four bytes", () => {
  const w = p.Writer(64);
  p.parse(w, "", "select $1", [0x80_00_00_01]);
  const x = w.take();
  return ["80000001", x.subarray(-4).toString("hex")];
});
