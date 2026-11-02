import { describe, expect, it } from "vitest";

import { formatMessage, messageArgumentNames, MessageSyntaxError, toIcuMessage } from "../src/catalog/index.js";

const ROLES = "{{count, plural, =0 {No roles} one {# role} other {# roles}}}";

describe("toIcuMessage", () => {
  it("rewrites double outer braces to ICU and quotes single braces in text", () => {
    expect(toIcuMessage("Hi {{name}}")).toBe("Hi {name}");
    expect(toIcuMessage(ROLES)).toBe("{count, plural, =0 {No roles} one {# role} other {# roles}}");
    expect(toIcuMessage("{{n, plural, other {in {{place}}}}}")).toBe("{n, plural, other {in {place}}}");
    expect(toIcuMessage("a {b} c")).toBe("a '{'b'}' c");
  });
});

describe("formatMessage", () => {
  it("keeps legacy {{name}} strings working, with or without spaces", () => {
    expect(formatMessage("Hello, {{name}}!", { name: "Ada" }, "en")).toBe("Hello, Ada!");
    expect(formatMessage("Hello, {{ name }}!", { name: "Ada" }, "en")).toBe("Hello, Ada!");
    expect(formatMessage("{{count}} enabled: {{enabled}}", { count: 2, enabled: true }, "en")).toBe("2 enabled: true");
  });

  it("selects plural branches with each locale's rules", () => {
    const pl = "{{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}}";
    expect([1, 2, 5, 22, 1.5].map((n) => formatMessage(pl, { n }, "pl"))).toEqual([
      "1 plik",
      "2 pliki",
      "5 plików",
      "22 pliki",
      "1,5 pliku",
    ]);
    const ru = "{{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}}";
    expect([1, 3, 11, 21].map((n) => formatMessage(ru, { n }, "ru"))).toEqual(["1 файл", "3 файла", "11 файлов", "21 файл"]);
    expect(formatMessage("{{n, plural, other {# 件}}}", { n: 1 }, "ja")).toBe("1 件");
    const ar = "{{n, plural, zero {لا ملفات} one {ملف} two {ملفان} few {# ملفات} many {# ملفًا} other {# ملف}}}";
    const arabic = (n: number): string => new Intl.NumberFormat("ar").format(n);
    expect([0, 1, 2, 3, 11, 100].map((n) => formatMessage(ar, { n }, "ar"))).toEqual([
      "لا ملفات",
      "ملف",
      "ملفان",
      `${arabic(3)} ملفات`,
      `${arabic(11)} ملفًا`,
      `${arabic(100)} ملف`,
    ]);
  });

  it("prefers exact =N branches and formats # per locale", () => {
    expect(formatMessage(ROLES, { count: 0 }, "en")).toBe("No roles");
    expect(formatMessage(ROLES, { count: 1 }, "en")).toBe("1 role");
    expect(formatMessage(ROLES, { count: 1200 }, "de")).toBe("1.200 roles");
    expect(formatMessage(ROLES, { count: "3" }, "en")).toBe("3 roles");
  });

  it("supports nested placeholders, select, selectordinal and number styles", () => {
    expect(formatMessage("{{n, plural, one {{{place}} has # role} other {{{place}} has # roles}}}", { n: 2, place: "Lisbon" }, "en")).toBe(
      "Lisbon has 2 roles",
    );
    const owner = "{{gender, select, female {Her team} male {His team} other {Their team}}}";
    expect(formatMessage(owner, { gender: "female" }, "en")).toBe("Her team");
    expect(formatMessage(owner, { gender: "unknown" }, "en")).toBe("Their team");
    const rank = "{{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}}";
    expect([1, 2, 3, 4, 11, 22].map((n) => formatMessage(rank, { n }, "en"))).toEqual(["1st", "2nd", "3rd", "4th", "11th", "22nd"]);
    expect(formatMessage("{{pct, number, ::percent}} more", { pct: 0.25 }, "en")).toBe("25% more");
    expect(formatMessage("on {{when, date, ::yyyyMMdd}}", { when: new Date(Date.UTC(2026, 0, 15, 12)) }, "en")).toMatch(/2026/);
  });

  it("follows ICU apostrophe quoting", () => {
    expect(formatMessage("Don't stop", {}, "en")).toBe("Don't stop");
    expect(formatMessage("l''{{company}}", { company: "Acme" }, "fr")).toBe("l'Acme");
    expect(formatMessage("{{n, plural, one {l''# offre} other {# offres}}}", { n: 1 }, "fr")).toBe("l'1 offre");
    expect(formatMessage("It''s", {}, "en")).toBe("It's");
    expect(formatMessage("Use '{{'name'}}' here", {}, "en")).toBe("Use {{name}} here");
    expect(formatMessage("L'{{company}}", { company: "Acme" }, "fr")).toBe("L{{company}}");
  });

  it("keeps single braces in plain text literal", () => {
    expect(formatMessage("JSON looks like {a: 1}", {}, "en")).toBe("JSON looks like {a: 1}");
    expect(formatMessage("{ {{name}} }", { name: "x" }, "en")).toBe("{ x }");
    expect(formatMessage("a }} b {'s {{name}}", { name: "x" }, "en")).toBe("a }} b {'s x");
    expect(formatMessage("{{n, plural, other {set '{a}' to #}}}", { n: 2 }, "en")).toBe("set {a} to 2");
    expect(() => formatMessage("{{n, plural, other {set {a} to #}}}", { n: 2 }, "en")).toThrow(MessageSyntaxError);
  });

  it("leaves missing or unusable values visible instead of throwing", () => {
    expect(formatMessage("Hi {{name}}", {}, "en")).toBe("Hi {{name}}");
    expect(formatMessage(`Showing {{visible}} of {{total, plural, one {# role} other {# roles}}}`, { total: 9 }, "en")).toBe(
      "Showing {{visible}} of 9 roles",
    );
    expect(formatMessage(ROLES, { count: "many" }, "en")).toBe(ROLES);
    expect(formatMessage("{{n, plural, other {# in {{place}}}}}", { n: 2 }, "en")).toBe("2 in {{place}}");
    expect(formatMessage("on {{when, date}}", { when: new Date(Number.NaN) }, "en")).toBe("on {{when, date}}");
  });

  it("falls back to a default locale for unknown or malformed tags", () => {
    expect(formatMessage(ROLES, { count: 2 }, "english")).toBe("2 roles");
    expect(formatMessage(ROLES, { count: 2 }, "zh_cn")).toBe("2 roles");
  });

  it("throws MessageSyntaxError with an offset into the original template", () => {
    const cases: Array<[string, number, RegExp]> = [
      ["Hi {{name", 3, /unclosed/],
      ["{{count, plural, one {# x}}}", 26, /other/],
      ["{{user.name}}", 0, /placeholder name/],
      ["{{first-name}}", 0, /placeholder name/],
      ["{{n, plural, one {x} other {y}}", 30, /close with }}/],
      ["{{n, foo}}", 5, /unknown placeholder type/],
      ["{{n, plural, one {x} one {y} other {z}}}", 21, /duplicate/],
    ];
    for (const [template, offset, reason] of cases) {
      let caught: unknown;
      try {
        formatMessage(template, { n: 1, count: 1, name: "x" }, "en");
      } catch (error) {
        caught = error;
      }
      expect(caught, template).toBeInstanceOf(MessageSyntaxError);
      if (!(caught instanceof MessageSyntaxError)) continue;
      expect(caught.offset, template).toBe(offset);
      expect(caught.reason, template).toMatch(reason);
    }
  });

  it("lists placeholder names, including nested ones", () => {
    expect(messageArgumentNames("{{n, plural, one {{{place}}} other {# {{place}} {{extra}}}}} {{name}}")).toEqual(
      new Set(["n", "place", "extra", "name"]),
    );
  });
});
