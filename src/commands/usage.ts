import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { printTable } from "../ui/table.js";

export interface UsageListOptions {
  key: string;
  fromDate?: string;
  toDate?: string;
  granularity?: string;
  fields?: string[];
  groupBy?: string[];
  out?: "text" | "csv";
}

type UsageRow = {
  time_bucket?: string;
  cost?: number;
  count?: number;
} & Record<string, unknown>;

export async function usageListCommand(
  opts: UsageListOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const query: Record<string, string | number | undefined> = {};
  if (opts.fromDate) query.from_date = opts.fromDate;
  if (opts.toDate) query.to_date = opts.toDate;
  if (opts.granularity) query.granularity = opts.granularity;
  if (opts.fields?.length) query.fields = opts.fields.join(",");
  if (opts.groupBy?.length) query.group_by = opts.groupBy.join(",");

  const rows = await api.get<UsageRow[]>("/v2/analytics/usage", query);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("(no usage data)");
    return;
  }

  const columns = Array.from(
    new Set<string>(
      ["time_bucket", "cost", "count", ...(opts.fields ?? [])].concat(
        rows.flatMap((r) => Object.keys(r)),
      ),
    ),
  );

  if (opts.out === "csv") {
    console.log(columns.join(","));
    for (const row of rows) {
      console.log(
        columns
          .map((c) => {
            const v = row[c as keyof UsageRow];
            if (v === undefined || v === null) return "";
            return String(v);
          })
          .join(","),
      );
    }
    return;
  }

  printTable(
    columns.map((c) => c.toUpperCase()),
    rows.map((row) =>
      columns.map((c) => {
        const v = row[c as keyof UsageRow];
        if (v === undefined || v === null) return "";
        if (c === "cost" && typeof v === "number") return v.toFixed(6);
        return String(v);
      }),
    ),
  );
}
