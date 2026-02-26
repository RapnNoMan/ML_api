module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body ?? {};
  const whosAskingRaw = body.whos_asking;
  const whosAsking =
    whosAskingRaw === null || whosAskingRaw === undefined
      ? null
      : String(whosAskingRaw).trim() || null;

  const buildingNumber = Number(body.building_number);
  const bathroomNumberFromFlat = Number(body.bathroom_number);

  // Backward compatibility: allow legacy bathroom_info[0] payload shape.
  const bathroomInfo = Array.isArray(body.bathroom_info) ? body.bathroom_info : [];
  const firstBathroom = bathroomInfo.length > 0 ? bathroomInfo[0] : {};
  const buildingFromLegacy = Number(firstBathroom.building_number);
  const bathroomNumberFromLegacy = Number(firstBathroom.bathroom_number);

  const resolvedBuildingNumber = Number.isFinite(buildingNumber)
    ? buildingNumber
    : buildingFromLegacy;
  const resolvedBathroomNumber = Number.isFinite(bathroomNumberFromFlat)
    ? bathroomNumberFromFlat
    : bathroomNumberFromLegacy;

  if (!Number.isFinite(resolvedBuildingNumber) || !Number.isFinite(resolvedBathroomNumber)) {
    res.status(400).json({
      error: "Missing required body params",
      required: ["building_number", "bathroom_number"],
    });
    return;
  }

  const status = resolvedBathroomNumber > 5 ? "busy" : "empty";
  res.status(200).json({
    building_number: resolvedBuildingNumber,
    bathroom_number: resolvedBathroomNumber,
    whos_asking: whosAsking,
    bathroom_info: bathroomInfo,
    status,
    message: `Bathroom ${resolvedBathroomNumber} in building ${resolvedBuildingNumber} is ${status}.`,
  });
};
