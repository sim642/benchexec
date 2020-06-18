// This file is part of BenchExec, a framework for reliable benchmarking:
// https://github.com/sosy-lab/benchexec
//
// SPDX-FileCopyrightText: 2019-2020 Dirk Beyer <https://www.sosy-lab.org>
//
// SPDX-License-Identifier: Apache-2.0

import { isNil, getRawOrDefault, omit } from "./utils";

const getFilterableData = ({ tools, rows }) => {
  const start = Date.now();
  const mapped = tools.map((tool, idx) => {
    let statusIdx;
    const { tool: toolName, date, niceName } = tool;
    let name = `${toolName} ${date} ${niceName}`;
    const columns = tool.columns.map((col, idx) => {
      if (!col) {
        return undefined;
      }
      if (col.type === "status") {
        statusIdx = idx;
        return { ...col, categories: {}, statuses: {}, idx };
      }
      if (col.type === "text") {
        return { ...col, distincts: {}, idx };
      }
      return { ...col, min: Infinity, max: -Infinity, idx };
    });

    if (isNil(statusIdx)) {
      console.log(`Couldn't find any status columns in tool ${idx}`);
      return undefined;
    }

    columns[statusIdx] = {
      ...columns[statusIdx],
      categories: {},
      statuses: {},
    };

    for (const row of rows) {
      for (const result of row.results) {
        // convention as of writing this commit is to postfix categories with a space character
        columns[statusIdx].categories[`${result.category} `] = true;

        for (const colIdx in result.values) {
          const col = result.values[colIdx];
          const { raw } = col;
          const filterCol = columns[colIdx];
          if (!filterCol || isNil(raw)) {
            continue;
          }

          if (filterCol.type === "status") {
            filterCol.statuses[raw] = true;
          } else if (filterCol.type === "text") {
            filterCol.distincts[raw] = true;
          } else {
            filterCol.min = Math.min(filterCol.min, Number(raw));
            filterCol.max = Math.max(filterCol.max, Number(raw));
          }
        }
      }
    }

    return {
      name,
      columns: columns.map(({ distincts, categories, statuses, ...col }) => {
        if (distincts) {
          return { ...col, distincts: Object.keys(distincts) };
        }
        if (categories) {
          return {
            ...col,
            categories: Object.keys(categories),
            statuses: Object.keys(statuses),
          };
        }
        return col;
      }),
    };
  });
  console.log({ mapped, creationTime: `${Date.now() - start} ms` });
  return mapped;
};

const applyNumericFilter = (filter, row, cell) => {
  const raw = getRawOrDefault(row[filter.id]);
  if (raw === undefined) {
    // empty cells never match
    return;
  }
  const filterParams = filter.value.split(":");

  if (filterParams.length === 2) {
    const [start, end] = filterParams;

    const numRaw = Number(raw);
    const numStart = start ? Number(start) : -Infinity;
    const numEnd = end ? Number(end) : Infinity;

    return numRaw >= numStart && numRaw <= numEnd;
  }

  if (filterParams.length === 1) {
    return raw.startsWith(filterParams[0]);
  }
  return false;
};
const applyTextFilter = (filter, row, cell) => {
  const raw = getRawOrDefault(row[filter.id]);
  if (raw === undefined) {
    // empty cells never match
    return;
  }
  return raw.includes(filter.value);
};

const buildMatcher = (filters) => {
  const start = Date.now();
  const out = filters.reduce((acc, { id, value }) => {
    if (isNil(value) || (typeof value === "string" && value.trim() === "all")) {
      return acc;
    }
    if (id === "id") {
      acc.id = { value };
      return acc;
    }
    const [tool, , columnIdx] = id.split("_");
    if (value === "diff") {
      if (!acc.diff) {
        acc.diff = [];
      }
      acc.diff.push({ col: columnIdx });
      return acc;
    }
    if (!acc[tool]) {
      acc[tool] = {};
    }
    let filter;
    if (value.includes(":")) {
      let [minV, maxV] = value.split(":");
      minV = minV === "" ? -Infinity : Number(minV);
      maxV = maxV === "" ? Infinity : Number(maxV);
      filter = { min: minV, max: maxV };
    } else {
      if (value[value.length - 1] === " ") {
        filter = { category: value.substr(0, value.length - 1) };
      } else {
        filter = { value };
      }
    }
    if (!acc[tool][columnIdx]) {
      acc[tool][columnIdx] = [];
    }
    acc[tool][columnIdx].push(filter);
    return acc;
  }, {});
  console.log(`Creating matcher took ${Date.now() - start} ms`);
  return out;
};

const applyMatcher = (matcher) => (data) => {
  const start = Date.now();
  let diffd = [...data];
  if (matcher.diff) {
    diffd = diffd.filter((row) => {
      for (const { col } of matcher.diff) {
        const vals = {};
        for (const tool of row.results) {
          const val = tool.values[col].raw;
          if (!vals[val]) {
            vals[val] = true;
          }
        }
        if (Object.keys(vals).length === 1) {
          return false;
        }
      }
      return true;
    });
  }
  if (!isNil(matcher.id)) {
    const { value: idValue } = matcher.id;
    diffd = diffd.filter(
      ({ href }) => href === idValue || href.includes(idValue),
    );
  }
  const out = diffd.filter((row) => {
    for (const tool in omit(["diff", "id"], matcher)) {
      for (const column in matcher[tool]) {
        let columnPass = false;
        for (const filter of matcher[tool][column]) {
          const { value, min, max, category } = filter;

          if (!isNil(min) && !isNil(max)) {
            const rawValue = row.results[tool].values[column].raw;
            if (isNil(rawValue)) {
              columnPass = false;
              continue;
            }
            const num = Number(rawValue);
            columnPass = columnPass || (num >= min && num <= max);
          } else if (!isNil(category)) {
            columnPass = columnPass || row.results[tool].category === category;
          } else {
            const rawValue = row.results[tool].values[column].raw;
            if (isNil(rawValue)) {
              columnPass = false;
              continue;
            }
            columnPass =
              columnPass || value === rawValue || rawValue.includes(value);
          }

          if (columnPass) {
            // as multiple values of the same column are OR connected,
            // we can abort if we pass since the result will always be true.
            break;
          }
        }
        if (!columnPass) {
          // values of the same column are OR connected
          // multiple columns in the same row are AND connected
          // if the matcher fails for one column, the whole row fails
          return false;
        }
      }
    }
    // all filter requirements were satisfied
    return true;
  });
  console.log(`matching took ${Date.now() - start} ms`);
  return out;
};

export {
  getFilterableData,
  applyNumericFilter,
  applyTextFilter,
  applyMatcher,
  buildMatcher,
};
