/**
 * D.PotD - AI Grading Endpoint
 * Uses Gemini API to automatically grade Q3 proof/explanation submissions
 * 
 * POST /api/grade-submission
 * Body: { q3Answer: string, rubric: array, questionText: string }
 * Returns: { success: boolean, score: number, feedback: string, confidence: string }
 */

// Gemini API configuration with fallback models
const GEMINI_ENDPOINTS = [
    // 2.5 generation
    { version: 'v1beta', model: 'gemini-2.5-flash' },
    { version: 'v1beta', model: 'gemini-2.5-pro' },
    { version: 'v1beta', model: 'gemini-2.5-flash-lite' },
    // 2.0 generation
    { version: 'v1beta', model: 'gemini-2.0-flash' },
    // 1.x generation
    { version: 'v1beta', model: 'gemini-1.5-flash' },
    { version: 'v1beta', model: 'gemini-1.5-pro' },
    { version: 'v1beta', model: 'gemini-1.0-pro' },
    { version: 'v1beta', model: 'gemini-pro' },
    // Mirror the same list on v1 endpoints (some keys surface models there)
    { version: 'v1', model: 'gemini-2.5-flash' },
    { version: 'v1', model: 'gemini-2.5-pro' },
    { version: 'v1', model: 'gemini-2.5-flash-lite' },
    { version: 'v1', model: 'gemini-2.0-flash' },
    { version: 'v1', model: 'gemini-1.5-flash' },
    { version: 'v1', model: 'gemini-1.5-pro' },
    { version: 'v1', model: 'gemini-1.0-pro' },
    { version: 'v1', model: 'gemini-pro' }
];

/**
 * Build the grading prompt for Gemini
 */
function buildGradingPrompt(questionText, studentAnswer, rubric) {
    // Convert rubric tables to readable format
    let rubricText = '';
    if (Array.isArray(rubric) && rubric.length > 0) {
        rubric.forEach((table, idx) => {
            if (table.title) rubricText += `\n### ${table.title}\n`;
            if (Array.isArray(table.columns) && Array.isArray(table.rows)) {
                rubricText += table.columns.join(' | ') + '\n';
                rubricText += table.columns.map(() => '---').join(' | ') + '\n';
                table.rows.forEach(row => {
                    if (Array.isArray(row)) {
                        rubricText += row.join(' | ') + '\n';
                    } else if (typeof row === 'object') {
                        // Handle object-format rows (c0, c1, etc.)
                        const cells = table.columns.map((_, i) => row[`c${i}`] || '');
                        rubricText += cells.join(' | ') + '\n';
                    }
                });
            }
        });
    }

    return `You are a strict mathematics grader for a competitive math olympiad program. Grade the following proof/explanation submission.

## QUESTION
${questionText}

## RUBRIC (Total: 10 points)
${rubricText || 'Award points based on: correctness (4pts), clarity (3pts), completeness (3pts)'}

## STUDENT SUBMISSION
${studentAnswer}

## GRADING INSTRUCTIONS
1. Evaluate the submission against the rubric criteria
2. Award a score from 0 to 10 (integers only)
3. Provide brief, constructive feedback in LaTeX format
4. Use a formal, encouraging tone appropriate for a 10th-grade student
5. Keep feedback minimal but precise (2-4 sentences max)

## OUTPUT FORMAT
Respond ONLY with valid JSON in this exact format:
{
    "score": <integer 0-10>,
    "feedback": "<LaTeX formatted feedback>",
    "confidence": "<low|medium|high>",
    "rubricBreakdown": {
        "<criterion1>": <points>,
        "<criterion2>": <points>
    }
}

Do not include any text outside the JSON object.`;
}

/**
 * Call Gemini API with fallback across multiple models
 */
async function callGeminiAPI(prompt, apiKey) {
    const errors = [];

    for (const cfg of GEMINI_ENDPOINTS) {
        const url = `https://generativelanguage.googleapis.com/${cfg.version}/models/${cfg.model}:generateContent?key=${apiKey}`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 1024,
                        topP: 0.8
                    }
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error?.message || `${cfg.model} request failed`);
            }

            const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
            if (!text) throw new Error('Empty response from Gemini');

            return { text, model: cfg.model };
        } catch (err) {
            errors.push(`${cfg.model}: ${err.message}`);
            continue;
        }
    }

    throw new Error(`All Gemini models failed: ${errors.join('; ')}`);
}

/**
 * Parse Gemini's JSON response with fallback handling
 */
function parseGradingResponse(text) {
    // Try to extract JSON from the response
    let jsonStr = text;

    // Handle markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    }

    // Try to find JSON object
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) {
        jsonStr = objectMatch[0];
    }

    try {
        const parsed = JSON.parse(jsonStr);

        // Validate required fields
        const score = Math.max(0, Math.min(10, Math.round(Number(parsed.score) || 0)));
        const feedback = String(parsed.feedback || 'No feedback provided.');
        const confidence = ['low', 'medium', 'high'].includes(parsed.confidence)
            ? parsed.confidence
            : 'medium';

        return {
            score,
            feedback,
            confidence,
            rubricBreakdown: parsed.rubricBreakdown || {}
        };
    } catch (e) {
        // Fallback: try to extract score from text
        const scoreMatch = text.match(/score[:\s]*(\d+)/i);
        return {
            score: scoreMatch ? Math.min(10, parseInt(scoreMatch[1], 10)) : 5,
            feedback: 'Unable to parse AI feedback. Please review manually.',
            confidence: 'low',
            rubricBreakdown: {}
        };
    }
}

/**
 * Main API handler
 */
export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { q3Answer, rubric, questionText } = req.body;

        // Validate input
        if (!q3Answer || typeof q3Answer !== 'string' || q3Answer.trim().length < 10) {
            return res.status(400).json({
                success: false,
                error: 'Invalid submission: Answer too short or missing'
            });
        }

        // Get API key from environment
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({
                success: false,
                error: 'Server configuration error: Missing API key'
            });
        }

        // Build prompt and call Gemini
        const prompt = buildGradingPrompt(
            questionText || 'Mathematical proof/explanation question',
            q3Answer,
            rubric || []
        );

        const { text, model } = await callGeminiAPI(prompt, apiKey);
        const result = parseGradingResponse(text);

        // Format feedback with LaTeX wrapper if needed
        let formattedFeedback = result.feedback;
        if (!formattedFeedback.includes('\\documentclass')) {
            formattedFeedback = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}

${formattedFeedback}

\\end{document}`;
        }

        return res.status(200).json({
            success: true,
            score: result.score,
            feedback: formattedFeedback,
            confidence: result.confidence,
            rubricBreakdown: result.rubricBreakdown,
            model: model
        });

    } catch (error) {
        console.error('Grade submission error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Failed to grade submission'
        });
    }
}
