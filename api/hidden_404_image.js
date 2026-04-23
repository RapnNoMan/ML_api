const fs = require("node:fs");
const path = require("node:path");

let cachedImage = null;

function getImageBuffer() {
  if (cachedImage) return cachedImage;
  const imagePath = path.join(process.cwd(), "TOP_SECRET.jpg");
  cachedImage = fs.readFileSync(imagePath);
  return cachedImage;
}

module.exports = async function handler(req, res) {
  try {
    const image = getImageBuffer();
    res.statusCode = 404;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Length", String(image.length));
    res.setHeader("Cache-Control", "public, max-age=300");
    res.end(image);
  } catch (_) {
    res.status(404).json({ error: "Not Found" });
  }
};
