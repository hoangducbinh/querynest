import { describe, it, expect } from "vitest";
import { createWorkspace } from "../../test/fixtures";
import { columnLetter, makeDraft, parseClipboard, pasteCells } from "./model";
describe("spreadsheet data entry", () => {
  it("parses Excel TSV including quoted newlines, tabs and CRLF", () => {
    expect(
      parseClipboard(
        '3\tAlex\talex@example.com\r\n4\t"Jo\tLee"\t"a""b\nc"\r\n',
      ),
    ).toEqual([
      ["3", "Alex", "alex@example.com"],
      ["4", "Jo\tLee", 'a"b\nc'],
    ]);
  });
  it("pastes multiple rows starting at a selected cell without truncating columns", () => {
    const t = createWorkspace().schema.tables[0];
    const rows = pasteCells([makeDraft()], t, 0, 0, [
      ["3", "Alex", "alex@example.com"],
      ["4", "Jo", "jo@example.com"],
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[1].cells).toEqual({
      id: "4",
      name: "Jo",
      email: "jo@example.com",
    });
    expect(() => pasteCells(rows, t, 0, 2, [["a", "b"]])).toThrow(
      /more columns/,
    );
  });
  it("supports the explicit clipboard NULL marker and Excel column letters", () => {
    const t = createWorkspace().schema.tables[0];
    expect(
      pasteCells([makeDraft()], t, 0, 0, [["\\N"]])[0].cells.id,
    ).toBeNull();
    expect([0, 25, 26, 51, 52].map(columnLetter)).toEqual([
      "A",
      "Z",
      "AA",
      "AZ",
      "BA",
    ]);
  });
  it("rejects edits of keyless rows and generated columns when pasting", () => {
    const table = createWorkspace().schema.tables[0];
    table.primaryKey = [];
    expect(() =>
      pasteCells([makeDraft({ id: 1 })], table, 0, 0, [["2"]]),
    ).toThrow(/primary key/);
    table.columns[0].generated = true;
    expect(() => pasteCells([makeDraft()], table, 0, 0, [["2"]])).toThrow(
      /generated/,
    );
  });
});
