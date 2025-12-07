// api/latex-helper.js
module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { message, previousMessages } = req.body; // allow history if we want to add context later
        const userMessage = message || '';

        if (!userMessage) {
            return res.status(400).json({ error: 'Message required' });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error('GEMINI_API_KEY not found in env');
            return res.status(500).json({ error: 'Server configuration error' });
        }

        // Try modern Gemini models
        const models = [
            'gemini-1.5-flash',
            'gemini-1.5-pro',
            'gemini-2.0-flash-exp' // if available, or fallbacks
        ];

        let resultText = null;
        let lastError = null;

        for (const model of models) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

                // System instruction for the helper
                const systemPrompt = "You are a helpful LaTeX assistant for high school math students. Your ONLY job is to help them format their math proofs in LaTeX. Do NOT solve math problems. Do NOT give hints about the solution. Only explain LaTeX syntax. Be concise.";

                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [
                            { role: 'user', parts: [{ text: systemPrompt + "\n\nUser request: " + userMessage }] }
                        ]
                    })
                });

                if (!response.ok) {
                    throw new Error(`Model ${model} failed with ${response.status}`);
                }

                const data = await response.json();
                const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';

                if (text) {
                    resultText = text;
                    break;
                }
            } catch (e) {
                lastError = e;
                continue;
            }
        }

        if (!resultText) {
            throw lastError || new Error('Failed to generate response from any model');
        }

        return res.status(200).json({ reply: resultText });

    } catch (error) {
        console.error('Latex helper API error:', error);
        return res.status(500).json({ error: error.message });
    }
};
