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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 720px; margin: 32px auto; padding: 0 16px; line-height: 1.5; color: #1a1a1a; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 28px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .sub { color: #666; font-size: .9rem; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  td, th { padding: 8px 6px; border-bottom: 1px solid #e5e5e5; text-align: left; vertical-align: middle; }
  input, button, select { font: inherit; padding: 6px 10px; border-radius: 4px; border: 1px solid #ccc; background: #fff; color: inherit; }
  input[type=text], input.url { width: 100%; box-sizing: border-box; }
  input.url[readonly] { background: #f4f4f5; }
  button { cursor: pointer; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  form.inline { display: inline; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row > input.url { flex: 1; }
  .checks { list-style: none; padding: 0; margin: 8px 0; }
  .checks li { padding: 4px 0; }
  .ok { color: #15803d; }
  .warn { color: #b45309; }
  .muted { color: #666; font-size: .85rem; }
  .msg { padding: 10px 12px; background: #eef2ff; border-radius: 4px; margin: 12px 0; }
  .err { padding: 10px 12px; background: #fee2e2; border-radius: 4px; margin: 12px 0; }
  details { margin: 8px 0; padding: 10px 12px; background: #f8f8f8; border-radius: 4px; }
  details summary { cursor: pointer; font-weight: 600; }
  details ol, details ul { margin: 8px 0 0; padding-left: 20px; }
  details code { background: #eee; padding: 1px 4px; border-radius: 3px; font-size: .9em; }
  a { color: #2563eb; }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e5e5; }
    h2 { border-color: #333; }
    td, th { border-color: #333; }
    input, button, select { background: #222; border-color: #444; color: #e5e5e5; }
    input.url[readonly] { background: #1a1a1a; }
    details { background: #1a1a1a; }
    details code { background: #333; }
    .msg { background: #1e293b; }
    .err { background: #3b1d1d; }
  }
</style>
</head>
<body>
${body}
<script>
function copyUrl(btn){var el=document.getElementById(btn.dataset.target);if(!el||!navigator.clipboard){return;}navigator.clipboard.writeText(el.value).then(function(){var t=btn.textContent;btn.textContent='Copied';setTimeout(function(){btn.textContent=t},1500)},function(){el.select();btn.textContent='Select + Ctrl+C'})}
</script>
</body>
</html>`;
}
