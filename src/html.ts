export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  td, th { padding: 8px; border-bottom: 1px solid #ddd; text-align: left; }
  input, button { font-size: 1rem; padding: 6px 10px; }
  form.inline { display: inline; }
  .msg { padding: 8px 12px; background: #eef2ff; border-radius: 4px; margin: 12px 0; }
  .err { padding: 8px 12px; background: #fee2e2; border-radius: 4px; margin: 12px 0; }
  a { color: #2563eb; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
