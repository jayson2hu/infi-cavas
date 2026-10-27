export function toCsv(rows: Array<Array<string | number | null | undefined>>) {
    return "\ufeff" + rows.map((row) => row.map((value) => {
        let text = String(value ?? "");
        if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
        return `"${text.replaceAll('"', '""')}"`;
    }).join(",")).join("\r\n");
}
