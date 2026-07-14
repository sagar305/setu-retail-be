const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || 'your-email@gmail.com',
    pass: process.env.SMTP_PASSWORD || 'your-app-password',
  },
});

const emailTemplates = {
  passwordReset: (resetLink, name) => ({
    subject: 'Password Reset Request',
    html: `
      <h2>Password Reset</h2>
      <p>Hi ${name},</p>
      <p>You requested a password reset. Click the link below to reset your password:</p>
      <p><a href="${resetLink}">Reset Password</a></p>
      <p>This link expires in 1 hour.</p>
      <p>If you didn't request this, please ignore this email.</p>
    `,
  }),

  invoiceNotification: (invoiceNumber, amount, customer) => ({
    subject: `Invoice ${invoiceNumber} Created`,
    html: `
      <h2>Invoice Created</h2>
      <p>Hi ${customer},</p>
      <p>Your invoice <strong>${invoiceNumber}</strong> has been created.</p>
      <p><strong>Amount:</strong> ₹${amount.toFixed(2)}</p>
      <p>Please retain this for your records.</p>
    `,
  }),

  lowStockAlert: (productName, currentStock, threshold) => ({
    subject: `Low Stock Alert: ${productName}`,
    html: `
      <h2>Low Stock Alert</h2>
      <p>Product <strong>${productName}</strong> is running low on stock.</p>
      <p><strong>Current Stock:</strong> ${currentStock}</p>
      <p><strong>Minimum Threshold:</strong> ${threshold}</p>
      <p>Please reorder soon.</p>
    `,
  }),

  orderConfirmation: (poNumber, items, total) => ({
    subject: `Purchase Order ${poNumber} Confirmed`,
    html: `
      <h2>Purchase Order Confirmation</h2>
      <p>Your PO <strong>${poNumber}</strong> has been confirmed.</p>
      <p><strong>Items:</strong> ${items.length}</p>
      <p><strong>Total Amount:</strong> ₹${total.toFixed(2)}</p>
    `,
  }),

  newUserOnboarding: (userName, loginLink) => ({
    subject: 'Welcome to Setu Retail POS',
    html: `
      <h2>Welcome!</h2>
      <p>Hi ${userName},</p>
      <p>Your account has been created. You can now log in:</p>
      <p><a href="${loginLink}">Login to Setu Retail</a></p>
      <p>If you have any questions, contact your administrator.</p>
    `,
  }),
};

const sendEmail = async (to, templateName, ...args) => {
  try {
    const template = emailTemplates[templateName];
    if (!template) {
      throw new Error(`Email template '${templateName}' not found`);
    }

    const emailContent = template(...args);

    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@setu-retail.com',
      to,
      ...emailContent,
    };

    const result = await transporter.sendMail(mailOptions);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Email send error:', error);
    return { success: false, error: error.message };
  }
};

module.exports = { sendEmail, emailTemplates };
