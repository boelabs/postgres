import Stream from "node:stream";

export default function largeObject(
  sql,
  oid,
  mode = 0x00_02_00_00 | 0x00_04_00_00
) {
  const { promise, resolve, reject } = Promise.withResolvers();
  sql
    .begin(async (tx) => {
      let loid = oid;
      if (!loid) {
        [{ oid: loid }] = await tx`select lo_creat(-1) as oid`;
      }
      const [{ fd }] = await tx`select lo_open(${loid}, ${mode}) as fd`;
      const { promise: closed, resolve: finish } = Promise.withResolvers();

      const readable = async ({
        highWaterMark = 2048 * 8,
        start = 0,
        end = Infinity,
      } = {}) => {
        let max = end - start;
        if (start) {
          await lo.seek(start);
        }

        return new Stream.Readable({
          highWaterMark,
          async read(size) {
            const l = Math.min(size, max);
            max -= l;
            const [{ data }] = await lo.read(l);
            if (data.length) {
              this.push(data);
            }
            if (data.length < l || max === 0) {
              this.push(null);
            }
          },
        });
      };

      const writable = async ({ highWaterMark = 2048 * 8, start = 0 } = {}) => {
        if (start) {
          await lo.seek(start);
        }

        return new Stream.Writable({
          highWaterMark,
          write(chunk, encoding, callback) {
            // oxlint-disable-next-line promise/no-callback-in-promise -- Node's Writable takes a callback; then(ok, fail) calls it exactly once and runs the query now, as await would a tick later
            lo.write(chunk).then(() => callback(), callback);
          },
        });
      };

      const lo = {
        close: () => tx`select lo_close(${fd})`.then(finish),
        read: (x) => tx`select loread(${fd}, ${x}) as data`,
        readable,
        seek: (x, whence = 0) => tx`select lo_lseek64(${fd}, ${x}, ${whence})`,
        size: () => tx`
          select
            lo_lseek64(${fd}, location, 0) as position,
            seek.size
          from (
            select
              lo_lseek64($1, 0, 2) as size,
              tell.location
            from (select lo_tell64($1) as location) tell
          ) seek
        `,
        tell: () => tx`select lo_tell64(${fd})`,
        truncate: (x) => tx`select lo_truncate64(${fd}, ${x})`,
        writable,
        write: (x) => tx`select lowrite(${fd}, ${x})`,
      };

      resolve(lo);

      return closed;
    })
    .catch(reject);
  return promise;
}
