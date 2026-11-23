// ทดสอบ API หลังเปิด server แล้ว: npm run test:smoke
const base = (process.env.API_BASE_URL || "http://localhost:3000/api").replace(
  /\/$/,
  "",
);
const webBase = base.replace(/\/api$/, "");
async function get(path) {
  const response = await fetch(base + path);
  const data = await response.json();
  if (!response.ok)
    throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function expectAuthentication(path, options = {}) {
  const response = await fetch(base + path, options);
  if (response.status !== 401 && response.status !== 403)
    throw new Error(
      `${path}: expected an authentication error, received HTTP ${response.status}`,
    );
}
(async () => {
  const homepageResponse = await fetch(`${webBase}/index.html`);
  const homepage = await homepageResponse.text();
  if (
    !homepageResponse.ok ||
    !homepage.includes("<title>Save & Share")
  )
    throw new Error(
      `homepage: expected the Save & Share site, received HTTP ${homepageResponse.status}`,
    );
  const health = await get("/health");
  if (!health.ok) throw new Error("health endpoint did not return ok=true");
  const list = await get("/universities");
  if (!Array.isArray(list.universities) || list.universities.length < 1)
    throw new Error(
      "universities endpoint returned no rows; check PostgreSQL schema/seed data",
    );
  const catalog = await get("/products");
  if (
    !Array.isArray(catalog.products) ||
    catalog.products.some((product) => !Array.isArray(product.images))
  )
    throw new Error("product list is missing its images array");
  await expectAuthentication("/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "test", images: [] }),
  });
  await expectAuthentication("/products/1", { method: "DELETE" });
  await expectAuthentication("/admin/products");
  await expectAuthentication("/admin/users/1", { method: "DELETE" });
  console.log("PASS homepage: /index.html");
  console.log(`PASS health: ${health.service}`);
  console.log(`PASS universities: ${list.universities.length} rows`);
  console.log(`PASS products: ${catalog.products.length} items expose images`);
  console.log("PASS create product: authentication required");
  console.log("PASS delete product: authentication required");
  console.log("PASS admin products: authentication required");
  console.log("PASS delete member: authentication required");
  console.log(
    "Public API smoke test passed. Protected routes still need JWT and role-specific testing.",
  );
})().catch((err) => {
  console.error("SMOKE TEST FAILED:", err.message);
  process.exitCode = 1;
});
