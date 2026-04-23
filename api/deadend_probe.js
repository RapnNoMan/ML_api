module.exports = async function handler(req, res) {
  const accept = String(req.headers.accept || "").toLowerCase();
  const ua = String(req.headers["user-agent"] || "").toLowerCase();

  const looksLikeCli =
    ua.includes("curl") ||
    ua.includes("wget") ||
    ua.includes("httpie") ||
    ua.includes("python-requests") ||
    ua.includes("powershell");

  const wantsHtml = accept.includes("text/html");
  const serveBrowserView = wantsHtml && !looksLikeCli;

  res.setHeader("Cache-Control", "no-store");

  if (!serveBrowserView) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send('{"status":"loaded","env":"production"}');
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Config</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; }
    img { max-width: min(80vw, 520px); height: auto; display: block; }
  </style>
</head>
<body>
  <img src="/env_dump_2026-04-23.jpg" alt="env preview">
</body>
</html>`);
};
