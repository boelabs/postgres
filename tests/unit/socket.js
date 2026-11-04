import { EventEmitter } from "node:events";

import { Socket } from "../../src/socket.js";
import { t } from "../test.js";

const fake = () => {
  // oxlint-disable-next-line unicorn/prefer-event-target -- it stands in for a Node socket, which is an EventEmitter
  const x = new EventEmitter();
  x.written = [];
  x.write = (data) => {
    x.written.push(data);
    return true;
  };
  x.end = (data) => {
    if (data) {
      x.written.push(data);
    }
    x.ended = true;
    return true;
  };
  x.destroy = () => x.emit("close", true);
  x.pause = () => (x.paused = true);
  x.resume = () => (x.paused = false);
  return x;
};

t("Socket takes the user socket", async () => {
  const raw = fake();
  const socket = await Socket({ socket: () => raw });
  return [true, socket.raw === raw];
});

t("Socket passes data, drain and writes through", async () => {
  const raw = fake();
  const socket = await Socket({ socket: () => Promise.resolve(raw) });
  const got = [];
  socket.ondata = (x) => got.push(x.toString());
  socket.ondrain = () => got.push("drain");
  raw.emit("data", Buffer.from("a"));
  raw.emit("drain");
  socket.write(Buffer.from("b"));
  return ["a,drain|b", `${got.join(",")}|${raw.written.join(",")}`];
});

t("Socket closes once with the error that came before", async () => {
  const raw = fake();
  const socket = await Socket({ socket: () => raw });
  const closes = [];
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- onclose is the callback property of the library's Socket, not a DOM event handler
  socket.onclose = (x) => closes.push(x && x.code);
  raw.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" }));
  raw.emit("close", true);
  raw.emit("close", true);
  return ["ECONNRESET", closes.join(",")];
});

t("Socket does not write after close", async () => {
  const raw = fake();
  const socket = await Socket({ socket: () => raw });
  raw.emit("close", false);
  return [
    "false,0,true",
    [socket.write(Buffer.from("x")), raw.written.length, socket.closed].join(
      ","
    ),
  ];
});

t("Socket pause and resume reach the user socket", async () => {
  const raw = fake();
  const socket = await Socket({ socket: () => raw });
  socket.pause();
  const { paused } = raw;
  socket.resume();
  return ["true,false", `${paused},${raw.paused}`];
});

t("Socket rejects when the user socket fails", async () => [
  "nope",
  await Socket({
    socket: () => {
      throw new Error("nope");
    },
  }).catch((error) => error.message),
]);

t(
  "Socket reads plain TCP through a shared buffer unless onread is false",
  async () => {
    const net = await import("node:net");
    const server = net.createServer((x) => x.end());
    const listening = Promise.withResolvers();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const { port } = server.address();
    const shared = await Socket({ ssl: false }, "127.0.0.1", port);
    const stream = await Socket(
      { onread: false, ssl: false },
      "127.0.0.1",
      port
    );
    shared.destroy();
    stream.destroy();
    server.close();
    return ["true,false", [shared.shared, stream.shared].join(",")];
  }
);
