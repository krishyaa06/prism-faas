// A tiny "image resize" handler: computes target dimensions keeping aspect ratio.
function handler(event, context) {
  const { width = 4000, height = 3000, max = 1024 } = event;
  const k = Math.min(1, max / Math.max(width, height));
  console.log(`resizing ${width}x${height} on ${context.vm || "local"}`);
  return { statusCode: 200, body: { width: Math.round(width * k), height: Math.round(height * k), scale: +k.toFixed(4) } };
}
module.exports = { handler };
