module.exports = function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
};

