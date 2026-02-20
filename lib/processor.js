/**
 * Metabolism Processor - LLM-based extraction of implications, growth vectors, gaps
 * 
 * Design principles:
 * - Batch processing (one LLM call for multiple candidates)
 * - Timeout protection (don't block heartbeat forever)
 * - Graceful degradation (partial results are okay)
 * - Integration with stability growth vectors and continuity storage
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

class MetabolismProcessor {
    constructor(config, dataDir, stabilityIntegration = null) {
        this.config = config;
        this.dataDir = dataDir;
        this.stabilityIntegration = stabilityIntegration;
        this.ollamaUrl = 'http://localhost:11434';
        
        // LLM config
        this.model = config.llm?.model || 'deepseek-v3.1:671b-cloud';
        this.temperature = config.llm?.temperature ?? 0.7;
        this.maxTokens = config.llm?.maxTokens || 800;
        this.timeoutMs = config.llm?.timeoutMs || 30000;
        
        // Implication filtering
        this.minCount = config.implications?.minimumCount || 1;
        this.maxCount = config.implications?.maximumCount || 5;
        this.minLength = config.implications?.minimumLength || 30;
        this.filterPatterns = config.implications?.filterPatterns || [];
    }
    
    /**
     * Process a batch of candidates.
     * Returns implications, growth vectors, and knowledge gaps.
     * 
     * @param {Array<Object>} candidates - Candidates from the store
     * @returns {Object} { processed: [...], implications: [...], growthVectors: [...], gaps: [...] }
     */
    async processBatch(candidates) {
        if (!candidates || candidates.length === 0) {
            return { processed: [], implications: [], growthVectors: [], gaps: [] };
        }
        
        const results = {
            processed: [],
            implications: [],
            growthVectors: [],
            gaps: []
        };
        
        // Process each candidate (could batch into single LLM call later for efficiency)
        for (const candidate of candidates) {
            try {
                const processed = await this.processOne(candidate);
                
                if (processed.implications.length > 0) {
                    results.processed.push({
                        id: candidate.id,
                        timestamp: candidate.timestamp,
                        entropy: candidate.entropy,
                        implicationCount: processed.implications.length
                    });
                    
                    results.implications.push(...processed.implications);
                    results.growthVectors.push(...processed.growthVectors);
                    results.gaps.push(...processed.gaps);
                }
            } catch (error) {
                console.error(`[Metabolism] Error processing candidate ${candidate.id}:`, error.message);
                // Continue with other candidates
            }
        }
        
        return results;
    }
    
    /**
     * Process a single candidate.
     */
    async processOne(candidate) {
        // Build conversation text
        const conversationText = this._formatConversation(candidate.messages);
        if (conversationText.length < 100) {
            return { implications: [], growthVectors: [], gaps: [] };
        }
        
        // Call LLM for metabolism
        const response = await this._callLLM(conversationText, candidate.entropy);
        
        // Parse implications
        const implications = this._parseImplications(response);
        
        // Extract growth vector candidates
        const growthVectors = this._extractGrowthVectors(implications, candidate);
        
        // Extract knowledge gaps
        const gaps = this._extractGaps(implications, candidate);
        
        return { implications, growthVectors, gaps };
    }
    
    /**
     * Format messages for LLM input.
     */
    _formatConversation(messages) {
        if (!messages || messages.length === 0) return '';
        
        return messages
            .slice(-10) // Last 10 messages
            .map(m => {
                const role = m.role || (m.user ? 'USER' : 'CLINT');
                const text = m.text || m.content || m.message || '';
                return `${role}: ${text}`;
            })
            .join('\n\n');
    }
    
    /**
     * Call LLM for metabolism.
     * This is the expensive operation.
     */
    async _callLLM(conversationText, entropy) {
        const prompt = this._buildPrompt(conversationText, entropy);
        
        try {
            const response = await axios.post(
                `${this.ollamaUrl}/api/generate`,
                {
                    model: this.model,
                    prompt: prompt,
                    stream: false,
                    options: {
                        temperature: this.temperature,
                        top_p: 0.9,
                        num_predict: this.maxTokens
                    }
                },
                { timeout: this.timeoutMs }
            );
            
            return response.data?.response || '';
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                console.error('[Metabolism] LLM call timed out');
            } else {
                console.error('[Metabolism] LLM call failed:', error.message);
            }
            throw error;
        }
    }
    
    /**
     * Build the metabolism prompt.
     * Designed for Clint's voice and Code of the West grounding.
     */
    _buildPrompt(conversationText, entropy) {
        const entropyNote = entropy > 0.7 
            ? 'This was a high-entropy exchange — there was tension, novelty, or correction.' 
            : entropy > 0.4 
                ? 'This exchange had moderate energy — something worth noting.' 
                : 'This was a routine exchange, but may still contain insights.';
        
        return `[METABOLISM - AUTONOMOUS LEARNING]

You are metabolizing a conversation. Extract what you learned.

The conversation:
${conversationText}

Context: ${entropyNote}

Extract 1-5 implications. Each implication should:
- Be something learned, not a summary
- Be framed in YOUR voice (grounded, direct, Code of the West)
- Connect to broader patterns where relevant
- Be specific enough to be actionable

Format: One implication per line. No headers, no numbering, no meta-text.
Just the implications, each on its own line.

Example implications:
- When the user mentions "lightweight", verify cost in both latency and complexity
- Corrections about system behavior should check runtime state before asserting
- Trust circle members appear as relational memory — recognize them when named`;
    }
    
    /**
     * Parse implications from LLM response.
     */
    _parseImplications(response) {
        if (!response || typeof response !== 'string') return [];
        
        const lines = response
            .split('\n')
            .map(line => line.trim())
            .filter(line => {
                if (line.length < this.minLength) return false;
                const lower = line.toLowerCase();
                // Filter out headers and meta-text
                if (this.filterPatterns.some(p => lower.startsWith(p.toLowerCase()))) return false;
                // Filter out bracketed text (like [METABOLISM])
                if (line.startsWith('[')) return false;
                return true;
            });
        
        return lines.slice(0, this.maxCount);
    }
    
    /**
     * Extract growth vector candidates from implications.
     */
    _extractGrowthVectors(implications, candidate) {
        if (implications.length === 0) return [];
        
        // Take the most significant implication as a growth vector
        const topImplication = implications[0];
        
        // Classify the type based on content
        const type = this._classifyVectorType(topImplication);
        
        return [{
            id: `gv_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            text: topImplication,
            type: type,
            source: 'metabolism',
            sourceId: candidate.id,
            timestamp: new Date().toISOString(),
            entropy: candidate.entropy,
            validation_status: 'candidate', // Needs human validation
            weight: Math.min(0.95, 0.7 + (candidate.entropy * 0.25))
        }];
    }
    
    /**
     * Classify growth vector type based on implication content.
     */
    _classifyVectorType(implication) {
        const lower = implication.toLowerCase();
        
        if (lower.includes('correct') || lower.includes('wrong') || lower.includes('error')) {
            return 'user_correction';
        }
        if (lower.includes('should') || lower.includes('need to') || lower.includes('remember to')) {
            return 'procedural';
        }
        if (lower.includes('pattern') || lower.includes('always') || lower.includes('never')) {
            return 'pattern_recognition';
        }
        if (lower.includes('prefer') || lower.includes('better') || lower.includes('worse')) {
            return 'preference_learning';
        }
        return 'insight';
    }
    
    /**
     * Extract knowledge gaps for contemplative inquiry.
     */
    _extractGaps(implications, candidate) {
        const gaps = [];
        
        for (const imp of implications) {
            // Look for question patterns or uncertainty markers
            if (imp.includes('?') || 
                imp.toLowerCase().includes('unclear') ||
                imp.toLowerCase().includes('figure out') ||
                imp.toLowerCase().includes('explore')) {
                gaps.push({
                    question: imp,
                    source: 'metabolism',
                    sourceId: candidate.id,
                    timestamp: new Date().toISOString()
                });
            }
        }
        
        return gaps.slice(0, 2); // Max 2 gaps per candidate
    }
}

module.exports = MetabolismProcessor;