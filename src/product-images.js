const MAX_PRODUCT_IMAGE_SIZE = 500 * 1024;

function jpegDimensions(imageBytes) {
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < imageBytes.length) {
    if (imageBytes[offset] !== 0xff) return null;
    while (imageBytes[offset] === 0xff) offset += 1;
    const marker = imageBytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > imageBytes.length) return null;
    const segmentLength = imageBytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > imageBytes.length)
      return null;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: imageBytes.readUInt16BE(offset + 3),
        width: imageBytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function decodeProductImage(dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    dataUrl,
  );
  if (!match) return null;
  const imageBytes = Buffer.from(match[1], "base64");
  if (
    imageBytes.length === 0 ||
    imageBytes.length > MAX_PRODUCT_IMAGE_SIZE ||
    imageBytes.toString("base64") !== match[1] ||
    imageBytes[0] !== 0xff ||
    imageBytes[1] !== 0xd8 ||
    imageBytes[2] !== 0xff
  )
    return null;
  const dimensions = jpegDimensions(imageBytes);
  if (
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > 1600 ||
    dimensions.height > 1600
  )
    return null;
  return imageBytes;
}

module.exports = { decodeProductImage, MAX_PRODUCT_IMAGE_SIZE };
