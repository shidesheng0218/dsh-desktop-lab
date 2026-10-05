/**
 * 导出序列化：CSV 与 JSON。
 *
 * 列定义不在这里，全部来自 `lib/report.js` 的 `TABLES` —— 保证 JSON 与 CSV
 * 出自同一份定义，不会出现「面板一个数、导出另一个数」。
 *
 * CSV 有两个必须处理的现实问题，这里的做法都写明了理由：
 *
 *  1. **公式注入**：单元格以 `= + @` 或制表符/回车开头时，Excel / Numbers
 *     会当成公式执行（`=cmd|...` 这类是真实攻击面）。默认在其前面加一个
 *     单引号 `'` 使其降级为文本。注意 `-` 只在「不是合法数字」时才加引号，
 *     否则会把负数变成文本。
 *  2. **Excel 的中文编码**：不带 BOM 的 UTF-8 CSV 在 Excel 里会显示成乱码。
 *     因此输出带 UTF-8 BOM。程序化消费方需要自行剥掉前三个字节 ——
 *     这一点写在 docs/report-schema.md 里，不是隐含行为。
 */
import { TABLES, tableRows } from './report.js';

/** UTF-8 BOM。给 Excel 用，程序化消费方需自行剥离。 */
export const UTF8_BOM = '\uFEFF';

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** 这些开头会被电子表格当作公式。 */
const FORMULA_PREFIX = /^[=+@\t\r]/;
/** 数字形态的 `-` 开头是普通负数，不该被当成公式。 */
const NUMERIC = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * 序列化一个单元格。
 * @param {unknown} value
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (text === '') return '';

  const looksLikeFormula = FORMULA_PREFIX.test(text) || (text.startsWith('-') && !NUMERIC.test(text));
  if (looksLikeFormula) text = `'${text}`;

  return /["\n\r,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 把报告的一张表序列化成 CSV 文本（含 BOM）。
 * @param {object} report buildReport 的返回值
 * @param {string} table TABLES 里的表名
 * @throws 表名未知，或 sessions 表缺少 includeSessions 时
 */
export function toCsv(report, table) {
  const spec = TABLES[table];
  if (spec === undefined) {
    throw new Error(`未知的导出表 "${table}"；可用：${Object.keys(TABLES).join(', ')}`);
  }
  const rows = tableRows(report, table);
  if (rows === null) {
    throw new Error(
      `导出 "${table}" 表需要全量会话明细，但报告未携带。` +
        '请在构建报告时传 includeSessions: true，而不是用 topSessions 静默截断。',
    );
  }

  const header = spec.columns.map((column) => csvCell(column.header)).join(',');
  const body = rows.map((row) =>
    spec.columns
      .map((column) => {
        let value;
        try {
          value = column.get(row);
        } catch {
          // 源形状与列定义不匹配时留空，而不是让整次导出失败。
          value = '';
        }
        return csvCell(value);
      })
      .join(','),
  );

  return `${UTF8_BOM}${[header, ...body].join('\n')}\n`;
}

/**
 * 生成内容处置头用的文件名。
 * @param {object} report
 * @param {string} table
 */
export function csvFilename(report, table) {
  const window = report?.window?.kind ?? 'all';
  const day = new Date(report?.generatedAt ?? Date.now()).toISOString().slice(0, 10);
  return `usage-insights-${table}-${window}-${day}.csv`;
}

/**
 * 把整份报告序列化成对外 JSON 文本。
 * @param {object} report
 */
export function toJson(report) {
  return JSON.stringify(report, null, 2);
}
