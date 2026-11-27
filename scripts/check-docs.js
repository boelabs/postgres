// Checks that every link between the repository's Markdown files leads somewhere: the file exists
// and, for a #fragment, so does the heading. Links to this repository on GitHub (as the README uses,
// so that they also work on npm) are checked against the files here. Other sites are not fetched.
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const github = "https://github.com/boelabs/postgres/blob/main/";
const skip = new Set(["node_modules", ".git", ".wrangler", "coverage"]);
const fence = /^```[\w-]*\s*$/u;
const cache = new Map();

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((x) => {
    if (skip.has(x.name)) {
      return [];
    }
    if (x.isDirectory()) {
      return walk(path.join(dir, x.name));
    }
    return [path.join(dir, x.name)];
  });

const links = (file) => {
  let inside = false;
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .flatMap((text, i) => {
      if (fence.test(text)) {
        inside = !inside;
      }
      if (inside) {
        return [];
      }
      return [
        ...text
          .replaceAll(/`[^`]*`/gu, "")
          .matchAll(/\]\((?<href>[^)\s]+)\)/gu),
      ].map((m) => ({ href: m.groups.href, line: i + 1 }));
    });
};

// The ids GitHub gives headings: lower case, punctuation dropped, spaces as dashes, repeats numbered.
const headings = (file) => {
  if (cache.has(file)) {
    return cache.get(file);
  }

  const seen = {};
  const ids = new Set();
  const add = (id) => {
    const n = seen[id] || 0;
    seen[id] = n + 1;
    ids.add(n ? `${id}-${n}` : id);
  };

  let inside = false;
  for (const text of fs.readFileSync(file, "utf-8").split("\n")) {
    if (fence.test(text)) {
      inside = !inside;
    }
    const m = !inside && text.match(/^#{1,6} (?<title>.*)$/u);
    if (m) {
      add(
        m.groups.title
          .trim()
          .toLowerCase()
          .replaceAll(/<[^>]+>/gu, "")
          .replaceAll(/[^\p{L}\p{N}\- _]/gu, "")
          .replaceAll(" ", "-")
      );
    }
  }
  cache.set(file, ids);
  return ids;
};

const check = (file, href) => {
  const target = (full, ref = href) => {
    const [local, anchor] = [
      full.split("#")[0],
      ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : null,
    ];
    if (!fs.existsSync(local)) {
      return "no such file";
    }
    if (anchor && local.endsWith(".md") && !headings(local).has(anchor)) {
      return "no such heading";
    }
    return null;
  };

  if (href.startsWith(github)) {
    return target(path.join(root, href.slice(github.length)));
  }
  if (/^[a-zA-Z]+:/u.test(href)) {
    return null;
  }

  const [rel] = href.split("#");
  return target(
    rel ? path.resolve(path.dirname(file), decodeURIComponent(rel)) : file,
    href
  );
};

const files = walk(root).filter((x) => x.endsWith(".md"));
const broken = files.flatMap((file) =>
  links(file).flatMap(({ href, line }) => {
    const problem = check(file, href);
    return problem
      ? [`${path.relative(root, file)}:${line} ${href} (${problem})`]
      : [];
  })
);

if (broken.length) {
  console.error(
    `${broken.length} broken link${
      broken.length === 1 ? "" : "s"
    }:\n${broken.join("\n")}`
  );
  process.exitCode = 1;
} else {
  console.log(`Links in ${files.length} Markdown files are fine.`);
}
