"use strict";

const assert = require("node:assert/strict");
const parser = require("./parser.js");

const labeled = parser.parseDeadline("締め切り: 2026/08/12 17:00");
assert.equal(new Date(labeled.timestamp).getFullYear(), 2026);
assert.equal(new Date(labeled.timestamp).getMonth(), 7);
assert.equal(new Date(labeled.timestamp).getDate(), 12);
assert.equal(new Date(labeled.timestamp).getHours(), 17);

const range = parser.parseDeadline("利用可能期間 2026/08/01 09:00 - 2026/08/31 23:59");
assert.equal(new Date(range.timestamp).getDate(), 31);
assert.equal(new Date(range.timestamp).getHours(), 23);
assert.equal(new Date(range.timestamp).getMinutes(), 59);

assert.equal(parser.courseIdFromUrl("https://example.test/webclass/course.php/abc123/"), "abc123");
assert.equal(parser.normalizeTitle("第1回レポート  提出済み"), "第1回レポート");
assert.equal(parser.parseDeadline("期限は設定されていません"), null);
assert.equal(parser.currentQuarter(new Date(2026, 7, 2)), "Q2");
assert.equal(parser.currentQuarter(new Date(2026, 9, 1)), "Q3");
assert.equal(parser.currentQuarter(new Date(2027, 0, 10)), "Q4");

console.log("parser tests: OK");
