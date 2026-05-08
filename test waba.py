import requests

ACCESS_TOKEN = "EAANg75g5obcBRXmWWceVfnN6wiwy6cchf9hGVkgdWhkkUIM7mYZBvWvkH0UZBpZA8asCyzwNFz0YEf3ud47ROOpj4kyNZBIHZBprWkBtMDWGoAe1P2T1RpJej9dkmZAE3Dlf02vg3NR7zh43ZBEllWIG1XAZAGfKMZAHBizfSOrfqaESGcqQTAklJVrj9SukvR2DZBapvmaio5K23LAv63ilR2kOr68C9IJpxEBYgaJPMEJVyKT0DClaaQcUz0dtT2LDgoMjv0ZB5ovIlEVlgwjJweVPAZDZD"
WABA_ID = "1438761837942297"

url = f"https://graph.facebook.com/v23.0/{WABA_ID}/phone_numbers"

headers = {
    "Authorization": f"Bearer {ACCESS_TOKEN}"
}

response = requests.get(url, headers=headers)

print("Status Code:", response.status_code)
print(response.json())