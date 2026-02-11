module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body ?? {};
  const whosAsking = String(body.whos_asking ?? "").trim();
  const bathroomInfo = Array.isArray(body.bathroom_info) ? body.bathroom_info : [];
  const firstBathroom = bathroomInfo.length > 0 ? bathroomInfo[0] : {};
  const buildingName = String(firstBathroom.building ?? "").trim();
  const bathroomNumberRaw = String(firstBathroom.bathroom_number ?? "").trim();
  const bathroomNumber = Number(bathroomNumberRaw);

  if (!buildingName || !Number.isFinite(bathroomNumber) || !whosAsking) {
    res.status(400).json({
      error: "Missing required body params",
      required: ["whos_asking", "bathroom_info[0].building", "bathroom_info[0].bathroom_number"],
    });
    return;
  }

  const status = bathroomNumber > 5 ? "busy" : "empty";
  res.status(200).json({
    building_name: buildingName,
    bathroom_number: bathroomNumber,
    whos_asking: whosAsking,
    bathroom_info: bathroomInfo,
    status,
    message: `Bathroom ${bathroomNumber} in ${buildingName} is ${status}.`,
  });
};
