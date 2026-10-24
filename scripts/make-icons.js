'use strict';
// Deterministic application icon conversion from our editable vector brand mark.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const directory = path.join(__dirname, '..', 'assets', 'brand');
const source = path.join(directory, 'mark.svg');

async function makeIcons() {
  await sharp(source).resize(512, 512).png().toFile(path.join(directory, 'icon.png'));
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map(size => sharp(source).resize(size, size).png().toBuffer()));
  let offset = 6 + sizes.length * 16;
  const header = Buffer.alloc(offset);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  images.forEach((image, i) => {
    const position = 6 + i * 16;
    header[position] = sizes[i] === 256 ? 0 : sizes[i];
    header[position + 1] = sizes[i] === 256 ? 0 : sizes[i];
    header.writeUInt16LE(1, position + 4);
    header.writeUInt16LE(32, position + 6);
    header.writeUInt32LE(image.length, position + 8);
    header.writeUInt32LE(offset, position + 12);
    offset += image.length;
  });
  fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([header, ...images]));
  console.log('Generated assets/brand/icon.png and icon.ico from mark.svg.');
}
makeIcons().catch(error => { console.error(error.message); process.exitCode = 1; });
