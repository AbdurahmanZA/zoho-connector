#!/usr/bin/env node
'use strict';
// Push your CRM's customers into Zoho Books, safely re-runnable.
//
//   node --env-file=.env examples/crm-sync.js examples/sample-crm.json            # dry run (default)
//   node --env-file=.env examples/crm-sync.js examples/sample-crm.json --apply    # really write
//
// The pattern that keeps a two-system sync sane:
//   1. One owner per field. Here the CRM owns name/address/contact person; Zoho owns money.
//   2. Store Zoho's contact_id next to your record the first time (here: a JSON map file;
//      in a real CRM, a zoho_id column). Match on that id ever after, email only the first time.
//   3. Dry-run by default, and print what would change.
const fs = require('node:fs');
const path = require('node:path');
const { ZohoClient, Books } = require('../src');

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) { console.log('usage: node --env-file=.env examples/crm-sync.js <crm.json> [--apply]'); process.exit(2); }

const MAP_FILE = process.env.ZOHO_ID_MAP || path.join(path.dirname(file), 'zoho-ids.json');

/** Your CRM record -> a Zoho Books contact. Change this to your own fields. */
function toZoho(c) {
  return {
    contact_name: c.company,
    company_name: c.company,
    contact_type: 'customer',
    ...(c.vatNumber ? { vat_reg_no: c.vatNumber } : {}),
    ...(c.paymentTermsDays != null ? { payment_terms: Number(c.paymentTermsDays) } : {}),
    billing_address: {
      address: c.address?.street, city: c.address?.city, state: c.address?.region,
      zip: c.address?.postalCode, country: c.address?.country,
    },
    contact_persons: [{
      first_name: c.contact?.firstName, last_name: c.contact?.lastName,
      email: c.contact?.email, phone: c.contact?.phone, is_primary_contact: true,
    }],
  };
}

async function main() {
  const crm = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};
  const books = new Books(ZohoClient.fromEnv());
  const tally = { created: 0, updated: 0, wouldCreate: 0, wouldUpdate: 0, failed: 0 };

  for (const rec of crm.customers || []) {
    const email = rec.contact?.email;
    try {
      if (!apply) {
        const known = ids[rec.id] || (await books.findContactByEmail(email))?.contact_id;
        tally[known ? 'wouldUpdate' : 'wouldCreate']++;
        console.log(`${known ? 'update' : 'create'}  ${rec.company} <${email}>${known ? '  (zoho ' + known + ')' : ''}`);
        continue;
      }
      const { contact, action } = await books.upsertContact(toZoho(rec), { zohoId: ids[rec.id], email });
      ids[rec.id] = contact.contact_id;
      tally[action]++;
      console.log(`${action}  ${rec.company}  -> zoho ${contact.contact_id}`);
    } catch (e) {
      tally.failed++;
      console.error(`FAILED  ${rec.company}: ${e.message}`);
    }
  }
  if (apply) fs.writeFileSync(MAP_FILE, JSON.stringify(ids, null, 2));
  console.log('\n' + Object.entries(tally).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') +
              (apply ? '' : '\nDry run - nothing was written. Add --apply to sync.'));
}

main().catch(e => { console.error(e.message); process.exit(1); });
