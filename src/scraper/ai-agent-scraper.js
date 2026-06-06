/**
 * AI agent scraper — uses Claude with tool use to fetch and parse cricket data.
 * Claude is given a fetch_url tool and autonomously decides which endpoints to
 * hit and how to parse the responses.
 */

const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { buildMatch } = require('./parser');

const AXIOS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const TOOLS = [
  {
    name: 'fetch_url',
    description: 'Fetch content from a URL. Returns the response body as text (JSON responses are stringified). Use this to retrieve cricket schedule data.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' },
        headers: {
          type: 'object',
          description: 'Optional extra HTTP headers (key-value pairs)',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'submit_matches',
    description: 'Submit the final list of extracted matches. Call this once you have collected all the match data you can find.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'URL or name of the data source used' },
        matches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              series:     { type: 'string', description: 'Series or tournament name' },
              team_home:  { type: 'string', description: 'Home team name' },
              team_away:  { type: 'string', description: 'Away team name' },
              venue:      { type: 'string', description: 'Venue / ground name' },
              date:       { type: 'string', description: 'Match date — ISO 8601 preferred, human-readable accepted' },
              match_type: { type: 'string', enum: ['Test', 'ODI', 'T20I', 'T20'], description: 'Format of the match' },
              status:     { type: 'string', enum: ['upcoming', 'live', 'completed'] },
              result:     { type: 'string', description: 'Result text if completed, e.g. "India won by 6 wickets"' },
            },
            required: ['team_home', 'team_away', 'match_type', 'status'],
          },
        },
      },
      required: ['matches'],
    },
  },
];

async function fetchUrlTool(url, extraHeaders = {}) {
  const res = await axios.get(url, {
    timeout: 15000,
    headers: { ...AXIOS_HEADERS, ...extraHeaders },
    responseType: 'text',
  });
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  // Truncate to keep token usage reasonable
  return text.length > 10000 ? text.slice(0, 10000) + '\n...[truncated]' : text;
}

async function scrapeWithAiAgent(team) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[AI Agent] ANTHROPIC_API_KEY not set — skipping AI agent scraper');
    return null;
  }

  const client = new Anthropic({ apiKey });
  const today = new Date().toISOString().split('T')[0];
  const espnTeamId = team === 'women' ? 289119 : 6;
  const teamLabel = team === 'women' ? "India Women's" : "India Men's";

  const systemPrompt = `You are a cricket schedule extraction agent for ${teamLabel} cricket.

Today is ${today}. Your task is to fetch cricket schedule data and return structured match information.

Rules:
- Only include matches where India (${team === 'women' ? "Women's" : "Men's"} team) is playing
- ${team === 'men' ? "Exclude Women's matches entirely" : "Only include Women's matches"}
- Include upcoming, currently live, and recently completed matches (last 30 days)
- match_type must be exactly one of: Test, ODI, T20I, T20
- Dates should be in ISO 8601 format if possible (e.g. "2025-06-15T14:00:00Z")
- When you have gathered enough data, call submit_matches`;

  const userMessage = `Fetch the ${teamLabel} cricket schedule. Try these endpoints in order until you find data:

1. ESPN Cricinfo schedule API:
   https://hs-consumer-api.espncricinfo.com/v1/pages/team/schedule?lang=en&teamId=${espnTeamId}
   (add header: Referer: https://www.espncricinfo.com/)

2. ESPN Cricinfo results API:
   https://hs-consumer-api.espncricinfo.com/v1/pages/team/results?lang=en&teamId=${espnTeamId}

3. BCCI schedule page (look for API calls / JSON data embedded in the page):
   https://www.bcci.tv/matches/schedule/${team}

Try each until you get valid match data, then call submit_matches with all the India ${team === 'women' ? "Women's" : "Men's"} matches you found.`;

  const messages = [{ role: 'user', content: userMessage }];
  let submittedMatches = null;
  let submittedSource = 'ai-agent';

  for (let turn = 0; turn < 8; turn++) {
    let response;
    try {
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      });
    } catch (err) {
      console.log(`[AI Agent] API call failed: ${err.message}`);
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        if (block.name === 'submit_matches') {
          submittedMatches = block.input.matches || [];
          submittedSource = block.input.source || 'ai-agent';
          console.log(`[AI Agent] Received ${submittedMatches.length} matches from: ${submittedSource}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Matches received. Done.',
          });
        } else if (block.name === 'fetch_url') {
          let content;
          try {
            console.log(`[AI Agent] Fetching: ${block.input.url}`);
            content = await fetchUrlTool(block.input.url, block.input.headers || {});
          } catch (err) {
            content = `Fetch failed: ${err.message}`;
            console.log(`[AI Agent] Fetch failed for ${block.input.url}: ${err.message}`);
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });

      if (submittedMatches !== null) break;
    }
  }

  if (!submittedMatches || submittedMatches.length === 0) {
    console.log('[AI Agent] No matches returned');
    return null;
  }

  const normalized = submittedMatches.map(m => buildMatch({
    series:    m.series || `India ${m.match_type} Series`,
    teams:     [m.team_home, m.team_away].filter(Boolean),
    venue:     m.venue || '',
    dateStr:   m.date || '',
    matchType: m.match_type || 'T20I',
    statusStr: m.status === 'completed' ? (m.result || 'Result') : (m.status || 'upcoming'),
  }));

  return { matches: normalized, source: submittedSource };
}

module.exports = { scrapeWithAiAgent };
