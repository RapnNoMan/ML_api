module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body ?? {};
  const buildingName = String(body.building_name ?? "").trim();
  const bathroomNumberRaw = String(body.bathroom_number ?? "").trim();
  const whosAsking = String(body.whos_asking ?? "").trim();
  const bathroomNumber = Number(bathroomNumberRaw);

  if (!buildingName || !Number.isFinite(bathroomNumber) || !whosAsking) {
    res.status(400).json({
      error: "Missing required body params",
      required: ["building_name", "bathroom_number", "whos_asking"],
    });
    return;
  }

  const status = bathroomNumber > 5 ? "busy" : "empty";
  res.status(200).json({
    building_name: buildingName,
    bathroom_number: bathroomNumber,
    whos_asking: whosAsking,
    status,
    message: `Bathroom ${bathroomNumber} in ${buildingName} is ${status}.`,
  });
};
