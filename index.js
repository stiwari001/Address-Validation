require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// Token cache
let cachedSugarToken = null;
let sugarTokenExpiresAt = 0;

// Get SugarCRM OAuth token
async function getSugarAuthToken() {
  const now = Date.now() / 1000;
  if (cachedSugarToken && now < sugarTokenExpiresAt - 60) {
    console.log('Using cached SugarCRM token');
    return cachedSugarToken;
  }

  console.log('Requesting new SugarCRM token...');
  const response = await axios.post(`${process.env.SUGAR_URL}/rest/v11_10/oauth2/token`, {
    grant_type: 'password',
    client_id: 'sugar',
    client_secret: '',
    username: process.env.SUGAR_USERNAME,
    password: process.env.SUGAR_PASSWORD,
    platform: process.env.SUGAR_PLATFORM || 'custom_api'
  });

  cachedSugarToken = response.data.access_token;
  sugarTokenExpiresAt = now + response.data.expires_in;

  console.log('Got new SugarCRM token');
  return cachedSugarToken;
}

// Get USPS OAuth token
async function getUSPSAccessToken() {
  console.log('Requesting USPS access token...');
  const res = await axios.post('https://apis-tem.usps.com/oauth2/v3/token', {
    client_id: process.env.USPS_CLIENT_ID,
    client_secret: process.env.USPS_CLIENT_SECRET,
    grant_type: 'client_credentials'
  });

  console.log('Got USPS access token');
  return res.data.access_token;
}

// Get Sugar contact
async function getSugarContact(id) {
  const token = await getSugarAuthToken();
  console.log(`Fetching SugarCRM contact with ID: ${id}`);

  const res = await axios.get(`${process.env.SUGAR_URL}/rest/v11_10/Contacts/${id}`, {
    headers: { 'OAuth-Token': token }
  });

  console.log('Got SugarCRM contact');
  return res.data;
}

// Update Sugar contact
async function updateSugarContact(id, data) {
  const token = await getSugarAuthToken();
  console.log(`Updating SugarCRM contact with ID: ${id}`);
  console.log('Data to update:', data);

  await axios.put(`${process.env.SUGAR_URL}/rest/v11_10/Contacts/${id}`, data, {
    headers: { 'OAuth-Token': token }
  });

  console.log('Successfully updated SugarCRM contact');
}

// USPS address validation route
app.get('/usps/validate', async (req, res) => {
  const recordId = req.query.record_id;
  if (!recordId) {
    console.log('Missing record_id in request');
    return res.status(400).send('Missing record_id');
  }

  try {
    const contact = await getSugarContact(recordId);

    const params = {
      streetAddress: contact.primary_address_street || '',
      secondaryAddress: contact.mailing_address_2_c || '',
      city: contact.primary_address_city || '',
      state: contact.primary_address_state || '',
      ZIPCode: contact.primary_address_postalcode || ''
    };

    console.log('👉 USPS validation input:', JSON.stringify(params, null, 2));

    // Check required fields before making the USPS request
    if (!params.streetAddress || !params.city || !params.state || !params.ZIPCode) {
      console.log('Missing one or more required address fields');
      return res.status(400).send('Missing one or more required address fields');
    }

    const uspsToken = await getUSPSAccessToken();

    const uspsResponse = await axios.get('https://apis-tem.usps.com/addresses/v3/address-standardization', {
      headers: {
        Authorization: `Bearer ${uspsToken}`,
        Accept: 'application/json'
      },
      params
    });

    console.log('USPS response received');

    const corrected = uspsResponse.data.address;
    console.log('Corrected address from USPS:', corrected);

    await updateSugarContact(recordId, {
      primary_address_street: corrected.streetAddressAbbreviation,
      primary_address_city: corrected.city,
      primary_address_state: corrected.state,
      primary_address_postalcode: corrected.ZIPCode,
      address_validation_status_c: 'Validated'
    });

    res.send(`<h3>Address validated and updated for Contact ID: ${recordId}</h3>`);
  } catch (err) {
    console.error('Error during validation:');
    console.error(err.response?.data || err.message || err);
    res.status(500).send(`<h3>Address validation failed</h3><pre>${err.message}</pre>`);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`USPS Validator running at http://localhost:${PORT}`);
});
