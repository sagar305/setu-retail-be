const Offer = require('../models/Offer');

exports.getOffers = async (req, res) => {
  try {
    const { active, category, skip = 0, limit = 50 } = req.query;
    const filter = { tenantId: req.tenantId };

    if (active === 'true') {
      filter.isActive = true;
      filter.endDate = { $gte: new Date() };
    }

    if (category) filter.applicableCategories = category;

    const offers = await Offers.find(filter)
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .sort({ startDate: -1 });

    const total = await Offer.countDocuments(filter);

    res.json({ offers, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createOffer = async (req, res) => {
  try {
    const { name, type, value, applicableCategories, applicableProducts, startDate, endDate, description } = req.body;

    const offer = new Offer({
      tenantId: req.tenantId,
      name,
      type,
      value,
      applicableCategories,
      applicableProducts,
      startDate,
      endDate,
      description,
      isActive: true,
    });

    await offer.save();
    res.status(201).json(offer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getOfferById = async (req, res) => {
  try {
    const offer = await Offer.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).populate('applicableProducts', 'name sku');

    if (!offer) return res.status(404).json({ message: 'Offer not found' });

    res.json(offer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateOffer = async (req, res) => {
  try {
    const offer = await Offer.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      req.body,
      { new: true }
    );

    if (!offer) return res.status(404).json({ message: 'Offer not found' });

    res.json(offer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deactivateOffer = async (req, res) => {
  try {
    const offer = await Offer.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      { isActive: false },
      { new: true }
    );

    if (!offer) return res.status(404).json({ message: 'Offer not found' });

    res.json(offer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getApplicableOffers = async (req, res) => {
  try {
    const { category, productId } = req.query;

    const filter = {
      tenantId: req.tenantId,
      isActive: true,
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() },
    };

    const offers = await Offer.find({
      ...filter,
      $or: [
        { applicableCategories: category },
        { applicableProducts: productId },
      ],
    });

    res.json(offers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
