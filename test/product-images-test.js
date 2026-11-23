const assert = require("node:assert/strict");
const {
  decodeProductImage,
  MAX_PRODUCT_IMAGE_SIZE,
} = require("../src/product-images");

function jpegFixture(width, height) {
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

assert.ok(decodeProductImage(jpegFixture(1280, 720)));
assert.equal(decodeProductImage("data:image/png;base64,AAAA"), null);
assert.equal(decodeProductImage(jpegFixture(1601, 720)), null);
assert.equal(
  decodeProductImage(
    `data:image/jpeg;base64,${Buffer.concat([
      Buffer.from(jpegFixture(1, 1).split(",")[1], "base64"),
      Buffer.alloc(MAX_PRODUCT_IMAGE_SIZE),
    ]).toString("base64")}`,
  ),
  null,
);

console.log("Product image validation tests passed.");
