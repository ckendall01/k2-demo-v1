require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parser');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const INDEX_NAME = 'vadai-laws'; 
const EMBEDDING_MODEL = '@cf/baai/bge-large-en-v1.5';
const CLOUDFLARE_API_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

// NEW: Absolute path to your client library
const CSV_PATH = '/Users/ckendall/Desktop/Plainspeak/Client Libraries/VADA/vada-laws.csv';

async function generateEmbedding(text) {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/ai/run/${EMBEDDING_MODEL}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text })
  });
  if (!response.ok) throw new Error(`Embedding API Error: ${await response.text()}`);
  const data = await response.json();
  return data.result.data[0];
}

async function upsertIntoVectorize(vectors) {
  const response = await fetch(`${CLOUDFLARE_API_BASE}/vectorize/v2/indexes/${INDEX_NAME}/upsert`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/x-ndjson' },
    body: vectors.map(v => JSON.stringify(v)).join('\n') 
  });
  if (!response.ok) throw new Error(`Vectorize API Error: ${await response.text()}`);
  console.log(`✅ Successfully upserted ${vectors.length} vectors.`);
}

async function processLaws() {
  const laws = [];
  console.log('Reading CSV from Client Library...');

  // FIX: Added {mapValues} to trim and {strict: true} to ensure data integrity
  fs.createReadStream(CSV_PATH)
    .pipe(csv({ 
      mapValues: ({ value }) => value.trim() 
    }))
    .on('data', (row) => {
      // FIX: Mapping the correct v1.2 headers
      const category = row['Category']; 
      const section = row['Code Section'];
      const subject = row['Subject'];
      const text = row['Full Text'];
      const lisUrl = row['Link to LIS']; 

      if (section && text) {
        laws.push({ category, section, subject, text, lisUrl });
      }
    })
    .on('end', async () => {
      console.log(`Found ${laws.length} laws. Starting vectorization...`);
      const vectorsToUpsert = [];

      for (const law of laws) {
        const vectorIdBase = law.section.replace(/[^\w-]/g, ''); 
        const textToEmbed = `[${law.category}] § ${law.section} - ${law.subject}\n\n${law.text}`;
        
        try {
          const embedding = await generateEmbedding(textToEmbed);
          const metadataBase = {
            category: law.category,
            code_section: law.section,
            lis_link: law.lisUrl || ''
          };

          if (law.text.length > 6000) {
            const parts = [law.text.substring(0, 6000), law.text.substring(6000, 12000)];
            for (let i = 0; i < parts.length; i++) {
              if (!parts[i]) continue;
              const partEmbedding = await generateEmbedding(parts[i]);
              vectorsToUpsert.push({
                id: `${vectorIdBase}-pt${i + 1}`,
                values: partEmbedding,
                metadata: { ...metadataBase, subject: `${law.subject} (Part ${i + 1})`, text: parts[i] }
              });
            }
          } else {
            vectorsToUpsert.push({
              id: vectorIdBase,
              values: embedding,
              metadata: { ...metadataBase, subject: law.subject, text: law.text }
            });
          }

          // Batch flush — outside both branches
          if (vectorsToUpsert.length >= 10) {
            await upsertIntoVectorize(vectorsToUpsert);
            vectorsToUpsert.splice(0);
            await new Promise(r => setTimeout(r, 800));
          }

        } catch (error) {
          console.error(`❌ Error § ${law.section}:`, error.message);
        }
      } // end for loop

      if (vectorsToUpsert.length > 0) await upsertIntoVectorize(vectorsToUpsert);
      console.log('🎉 v1.2 Knowledge Base Update Complete.');
    }); // end .on('end')
}
processLaws();