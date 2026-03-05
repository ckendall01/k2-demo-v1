export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    try {
      const payload = await request.json();
      
      if (payload.type === 'phase2') {
        return await handlePhase2(payload, env, request);
      } else {
        return await handlePhase1(payload, env, request);
      }

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }
  }
};

async function handlePhase1(payload, env, request) {
  const messages = payload.messages || [];
  const userMessage = messages[messages.length - 1].content;

  const embeddingResponse = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [userMessage] });
  const queryVector = embeddingResponse.data[0];

  const matches = await env.VECTORIZE.query(queryVector, { topK: 8, returnMetadata: true });

  const context = matches.matches
    .filter(match => match.score > 0.35)
    .map(match => {
      const lisLink = (match.metadata.lis_link && match.metadata.lis_link !== 'null') 
                      ? match.metadata.lis_link 
                      : generateLISLink(match.metadata.code_section);
      return `[Category: ${match.metadata.category}] [Statute § ${match.metadata.code_section}]: ${match.metadata.subject}\nOfficial LIS Link: ${lisLink}\nText: ${match.metadata.text}`;
    })
    .join('\n\n---\n\n');

  const systemPrompt = `You are VADAi, a strict legal awareness assistant for VADA. 
  RULES:
  1. ONLY use the "LAW BOOK CONTEXT" provided below.
  2. ALWAYS include the "Official LIS Link" for any statute you cite. Format it as a clickable Markdown link: [Official LIS Link](URL).
  3. If a statute cross-references another code not in the context, do not guess its contents.
  4. Do not use your own internal memory for Virginia law.
  5. If you cannot find a specific answer, start your response with: "I'm sorry, the current VADAi database does not contain the specific statute required to answer this."

  LAW BOOK CONTEXT:
  ${context || 'NO RELEVANT STATUTES FOUND.'}`;

  const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', 
      max_tokens: 1200,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: messages
    })
  });

  const result = await anthropicResponse.json();
  return new Response(JSON.stringify(result), { headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } });
}

async function handlePhase2(payload, env, request) {
  const { mode, query, previousAnswer } = payload;
  let systemPrompt = "";
  let messages = [];

  if (mode === "draft") {
    systemPrompt = "You are K2, an expert drafting assistant. Use ONLY the provided Phase 1 factual answer to fulfill the user's drafting request. Maintain a professional, plainspeak tone. Include LIS links if they were in the context. DO NOT invent new legal codes.";
    messages = [
      { role: "user", content: `FACTUAL CONTEXT:\n${previousAnswer}\n\n---\nUSER DRAFTING REQUEST:\n${query}` }
    ];
  } 
  else if (mode === "research") {
    const embeddingResponse = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [query] });
    const queryVector = embeddingResponse.data[0];
    const matches = await env.VECTORIZE.query(queryVector, { topK: 8, returnMetadata: true });
    
    const newContext = matches.matches
      .filter(match => match.score > 0.35)
      .map(match => {
        const lisLink = (match.metadata.lis_link && match.metadata.lis_link !== 'null') 
                        ? match.metadata.lis_link 
                        : generateLISLink(match.metadata.code_section);
        return `[Category: ${match.metadata.category}] [Statute § ${match.metadata.code_section}]: ${match.metadata.subject}\nOfficial LIS Link: ${lisLink}\nText: ${match.metadata.text}`;
      })
      .join('\n\n---\n\n');

    systemPrompt = "You are VADAi, a strict legal awareness assistant. Answer the user's follow-up question using the NEW context provided. Format LIS links as [Official LIS Link](URL).";
    messages = [
      { role: "user", content: `Previous Answer Context:\n${previousAnswer}\n\nNew Virginia Code Context:\n${newContext || 'NO RELEVANT STATUTES FOUND.'}\n\nFollow-up Question: ${query}` }
    ];
  }

  if (!systemPrompt) {
    return new Response(JSON.stringify({ error: 'Invalid mode provided for Phase 2.' }), { 
      status: 400, 
      headers: corsHeaders(request) 
    });
  }

  const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: systemPrompt,
      messages: messages
    })
  });

  const result = await anthropicResponse.json();
  return new Response(JSON.stringify(result), { headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } });
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-beta',
    'Access-Control-Max-Age': '86400'
  };
}

function generateLISLink(codeSection) {
  if (!codeSection) return 'Link not available';
  const cleanSection = codeSection.replace(/[^\d.-]/g, '');
  return `https://law.lis.virginia.gov/vacode/${cleanSection}/`;
}