const generateEAN13 = async (code) => {
  try {
    if (code.length !== 12) {
      return { success: false, error: 'EAN13 code must be 12 digits (checksum will be added)' };
    }

    const checksum = calculateEAN13Checksum(code);
    const fullCode = code + checksum;
    const svg = generateBarcodeSVG(fullCode);
    const buffer = Buffer.from(svg);

    return {
      success: true,
      buffer,
      format: 'svg',
      code: fullCode,
    };
  } catch (error) {
    console.error('Barcode generation error:', error);
    return { success: false, error: error.message };
  }
};

const generateQRCode = async (data) => {
  try {
    const qrSvg = generateSimpleQR(data);
    const buffer = Buffer.from(qrSvg);

    return {
      success: true,
      buffer,
      format: 'svg',
    };
  } catch (error) {
    console.error('QR code generation error:', error);
    return { success: false, error: error.message };
  }
};

const generateBarcodeSVG = (code) => {
  const barWidth = 2;
  const barHeight = 50;
  let svg = `<svg width="${code.length * barWidth + 20}" height="${barHeight + 40}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="${code.length * barWidth + 20}" height="${barHeight + 40}" fill="white"/>`;

  let xPos = 10;
  for (const digit of code) {
    const isBar = parseInt(digit) % 2 === 0;
    if (isBar) {
      svg += `<rect x="${xPos}" y="10" width="${barWidth}" height="${barHeight}" fill="black"/>`;
    }
    xPos += barWidth;
  }

  svg += `<text x="10" y="${barHeight + 30}" font-size="12" font-family="Arial, sans-serif" font-weight="bold">${code}</text>`;
  svg += '</svg>';
  return svg;
};

const generateSimpleQR = (data) => {
  const size = 200;
  const hash = data.split('').reduce((a, b) => a + b.charCodeAt(0), 0);

  let qrSvg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">`;
  qrSvg += `<rect width="${size}" height="${size}" fill="white"/>`;

  for (let i = 0; i < size; i += 20) {
    for (let j = 0; j < size; j += 20) {
      if (((i + j + hash) % 40) < 20) {
        qrSvg += `<rect x="${i}" y="${j}" width="20" height="20" fill="black"/>`;
      }
    }
  }

  qrSvg += '</svg>';
  return qrSvg;
};

const generateWeightBasedBarcode = (sku, weight, price) => {
  const skuCode = sku.padEnd(5, '0').substring(0, 5);
  const weightCode = String(Math.round(weight * 100)).padStart(4, '0');
  const priceCode = String(Math.round(price * 100)).padStart(3, '0');

  const barcodeData = skuCode + weightCode + priceCode;
  const checksum = calculateEAN13Checksum(barcodeData);

  return barcodeData + checksum;
};

const calculateEAN13Checksum = (code) => {
  let sum = 0;
  for (let i = 0; i < code.length; i++) {
    sum += parseInt(code[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const checksum = (10 - (sum % 10)) % 10;
  return checksum.toString();
};

const generateInvoiceQR = async (invoiceNumber, amount, customerPhone) => {
  const qrData = JSON.stringify({
    inv: invoiceNumber,
    amt: amount,
    phone: customerPhone,
    ts: new Date().toISOString(),
  });

  return await generateQRCode(qrData);
};

const generateProductBarcode = async (sku, productName) => {
  const barcodeText = `${sku}`.padStart(12, '0');
  return await generateEAN13(barcodeText.substring(0, 12));
};

module.exports = {
  generateEAN13,
  generateQRCode,
  generateWeightBasedBarcode,
  generateInvoiceQR,
  generateProductBarcode,
  calculateEAN13Checksum,
};
