/**
 * AI fallback using Claude Haiku — called ONLY when:
 * 1. Playwright returns empty/unexpected HTML
 * 2. User requests a series summary
 * 3. A new series can't be auto-categorized
 *
 * NEVER called on routine cron runs.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { insertAiUsageLog } = require('../db/db');

let _client;

function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set — AI fallback unavailable');
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const MODEL = 'claude-haiku-4-5';

/**
 * Fallback: ask Claude to extract match schedule from raw HTML
 * when our normal parser returns nothing.
 */
async function extractMatchesFromHtml(html, team = 'men') {
  const logEntry = {
    reason: 'fallback_parser',
    model: MODEL,
    team,
    success: true,
  };

  try {
    const client = getClient();

    // Truncate HTML to keep costs low — first 8k chars usually contains fixtures
    const truncated = html.slice(0, 8000);

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `Extract cricket match schedule data from this HTML snippet of the BCCI ${team}'s cricket schedule page.

Return a JSON array of matches with these fields:
- series_name (string)
- team_home (string)
- team_away (string)
- venue (string)
- match_date (string, as shown on page)
- match_type (string: "Test", "ODI", "T20I", "T20")
- status (string: "upcoming", "live", or "completed")
- result (string or null — score/result if available)

HTML:
\`\`\`html
${truncated}
\`\`\`

Return ONLY the JSON array, no explanation. If no matches found, return [].`,
        },
      ],
    });

    const usage = message.usage;
    logEntry.prompt_tokens = usage.input_tokens;
    logEntry.completion_tokens = usage.output_tokens;
    logEntry.total_tokens = usage.input_tokens + usage.output_tokens;

    const content = message.content[0]?.text || '[]';
    // Extract JSON from potential markdown code fence
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
    const parsed = JSON.parse(jsonMatch[1].trim());

    insertAiUsageLog(logEntry);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logEntry.success = false;
    logEntry.error_message = err.message;
    try { insertAiUsageLog(logEntry); } catch {}
    console.error('[AI Fallback] extractMatchesFromHtml failed:', err.message);
    return [];
  }
}

/**
 * Generate a summary for a specific series (on-demand only).
 */
async function generateSeriesSummary(seriesName, matches, team = 'men') {
  const logEntry = {
    reason: 'series_summary',
    model: MODEL,
    team,
    series_id: seriesName,
    success: true,
  };

  try {
    const client = getClient();

    const matchList = matches
      .slice(0, 10)
      .map(m => `- ${m.match_type}: ${m.team_home} vs ${m.team_away} at ${m.venue} on ${m.match_date_ist} [${m.status}]${m.result ? ' — ' + m.result : ''}`)
      .join('\n');

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: `Write a concise 2-3 sentence summary for this cricket series:

Series: ${seriesName}
Team: India ${team === 'men' ? "Men's" : "Women's"} Cricket

Matches:
${matchList}

Focus on: current standings, upcoming key matches, and any notable context. Keep it under 60 words.`,
        },
      ],
    });

    const usage = message.usage;
    logEntry.prompt_tokens = usage.input_tokens;
    logEntry.completion_tokens = usage.output_tokens;
    logEntry.total_tokens = usage.input_tokens + usage.output_tokens;

    insertAiUsageLog(logEntry);
    return message.content[0]?.text || '';
  } catch (err) {
    logEntry.success = false;
    logEntry.error_message = err.message;
    try { insertAiUsageLog(logEntry); } catch {}
    console.error('[AI Fallback] generateSeriesSummary failed:', err.message);
    return null;
  }
}

/**
 * Auto-categorize a series when match type can't be determined from title alone.
 */
async function categorizeSeries(seriesName, team = 'men') {
  const logEntry = {
    reason: 'auto_categorize',
    model: MODEL,
    team,
    series_id: seriesName,
    success: true,
  };

  try {
    const client = getClient();

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: `Given this cricket series name: "${seriesName}", what match format(s) does it include?
Reply with ONLY a comma-separated list from: Test, ODI, T20I, T20. Example: "T20I" or "ODI, T20I"`,
        },
      ],
    });

    const usage = message.usage;
    logEntry.prompt_tokens = usage.input_tokens;
    logEntry.completion_tokens = usage.output_tokens;
    logEntry.total_tokens = usage.input_tokens + usage.output_tokens;

    insertAiUsageLog(logEntry);
    return message.content[0]?.text?.trim() || 'T20';
  } catch (err) {
    logEntry.success = false;
    logEntry.error_message = err.message;
    try { insertAiUsageLog(logEntry); } catch {}
    return 'T20';
  }
}

module.exports = {
  extractMatchesFromHtml,
  generateSeriesSummary,
  categorizeSeries,
};
