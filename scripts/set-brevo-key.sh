#!/bin/zsh
# Asks for the Brevo API key (hidden while you paste) and saves it in Railway
# as BREVO_API_KEY for the "web" service. The key is never printed or stored in a file.

echo "Paste your Brevo API key (starts with xkeysib-), then press Enter."
echo "Nothing will appear while you paste. That's normal."
read -s "key?> "
echo

key="${key//[[:space:]]/}"
if [[ "$key" != xkeysib-* ]]; then
  echo "That doesn't look like a Brevo API key (it should start with xkeysib-). Nothing was saved."
  exit 1
fi

if railway variables --set "BREVO_API_KEY=$key" --service web > /dev/null; then
  echo "Saved. Railway is restarting the site. Go back to Claude and say it's done."
else
  echo "Couldn't save it to Railway. Nothing was changed."
  exit 1
fi
