const bwipjs = require('bwip-js');

const generateEAN13 = async (code) => {
  try {
    if (code.length !== 12) {
      return { success: false, error: 'EAN13 code must be 12 digits (checksum will be added)' };
    }

    const png = await bwipjs.toBuffer({
      bcid: 'ean13',
      text: code,
      scale: 3,
      height: 10,
      includetext: true,
      textxoffset: 0,
    });

    return {
      success: true,
      buffer: png,
      format: 'png',
    };
  } catch (error) {
    console.error('Barcode generation error:', error);
    return { success: false, error: error.message };
  }
};

const generateQRCode = async (data) => {
  try {
    const png = await bwipjs.toBuffer({
      bcid: 'qrcode',
      text: data,
      scale: 5,
      margin: 10,
    });

    return {
      success: true,
      buffer: png,
      format: 'png',
    };
  } catch (error) {
    console.error('QR code generation error:', error);
    return { success: false, error: error.message };
  }
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
