/**
 * Test script for openclaw-plugin-metabolism
 * 
 * Usage: node test.js
 * 
 * Tests:
 * 1. CandidateStore - write, get, mark processed
 * 2. MetabolismProcessor - LLM call (requires Ollama)
 * 3. Growth vector integration - write to file
 */

const path = require('path');
const fs = require('fs');

// Test config
const TEST_DIR = path.join(__dirname, 'data', 'test');
const CONFIG = {
    thresholds: { entropyMinimum: 0.6, cooldownMinutes: 30 },
    processing: { batchSize: 3, maxPendingCandidates: 50 },
    llm: { model: 'deepseek-v3.1:671b-cloud', temperature: 0.7, maxTokens: 800, timeoutMs: 30000 },
    storage: { candidatesDir: 'candidates', processedDir: 'processed' },
    implications: { minimumCount: 1, maximumCount: 5, minimumLength: 30, filterPatterns: ['implication', 'format:', 'note:'] }
};

// Cleanup test directory
function cleanup() {
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(path.join(TEST_DIR, 'candidates'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'processed'), { recursive: true });
}

// Test results
const results = { passed: 0, failed: 0, tests: [] };

function test(name, fn) {
    console.log(`\n▶ ${name}`);
    try {
        fn();
        results.passed++;
        results.tests.push({ name, status: 'PASS' });
        console.log(`  ✓ PASS`);
    } catch (error) {
        results.failed++;
        results.tests.push({ name, status: 'FAIL', error: error.message });
        console.log(`  ✗ FAIL: ${error.message}`);
    }
}

async function asyncTest(name, fn) {
    console.log(`\n▶ ${name}`);
    try {
        await fn();
        results.passed++;
        results.tests.push({ name, status: 'PASS' });
        console.log(`  ✓ PASS`);
    } catch (error) {
        results.failed++;
        results.tests.push({ name, status: 'FAIL', error: error.message });
        console.log(`  ✗ FAIL: ${error.message}`);
    }
}

// =============================================================================
// TESTS
// =============================================================================

async function runTests() {
    console.log('═'.repeat(60));
    console.log(' METABOLISM PLUGIN TESTS');
    console.log('═'.repeat(60));

    cleanup();

    // ---------------------------------------------------------------------------
    // 1. CandidateStore tests
    // ---------------------------------------------------------------------------
    console.log('\n' + '─'.repeat(60));
    console.log(' CANDIDATE STORE');
    console.log('─'.repeat(60));

    const CandidateStore = require('./lib/candidateStore');
    const store = new CandidateStore(CONFIG, TEST_DIR);

    test('write() creates candidate file', () => {
        const id = store.write({
            timestamp: new Date().toISOString(),
            userId: 'test-user',
            entropy: 0.75,
            messages: [
                { role: 'user', content: 'Test message' },
                { role: 'assistant', content: 'Test response' }
            ]
        });
        
        if (!id || !id.startsWith('cand_')) {
            throw new Error(`Invalid candidate ID: ${id}`);
        }
        
        const stats = store.getStats();
        if (stats.pending !== 1) {
            throw new Error(`Expected 1 pending, got ${stats.pending}`);
        }
    });

    test('getPending() returns candidates sorted by entropy', () => {
        // Add more candidates with different entropy
        store.write({ entropy: 0.5, messages: [{ role: 'user', content: 'Low' }] });
        store.write({ entropy: 0.9, messages: [{ role: 'user', content: 'High' }] });
        
        const pending = store.getPending(3);
        if (pending.length !== 3) {
            throw new Error(`Expected 3 candidates, got ${pending.length}`);
        }
        
        // Should be sorted by entropy descending
        if (pending[0].entropy < pending[1].entropy) {
            throw new Error('Candidates not sorted by entropy');
        }
        
        console.log(`    Entropies: ${pending.map(p => p.entropy.toFixed(2)).join(', ')}`);
    });

    test('markProcessed() moves to processed dir', () => {
        const pending = store.getPending(1);
        const id = pending[0].id;
        
        store.markProcessed(id, { implications: 2 });
        
        const stats = store.getStats();
        if (stats.processed !== 1) {
            throw new Error(`Expected 1 processed, got ${stats.processed}`);
        }
    });

    test('pruning works when over limit', () => {
        // Write many candidates
        for (let i = 0; i < 60; i++) {
            store.write({ entropy: 0.5 + Math.random() * 0.4, messages: [] });
        }
        
        const stats = store.getStats();
        if (stats.pending > 50) {
            throw new Error(`Pruning failed: ${stats.pending} pending (max 50)`);
        }
        console.log(`    Pruned to ${stats.pending} candidates`);
    });

    // ---------------------------------------------------------------------------
    // 2. Processor tests (requires Ollama)
    // ---------------------------------------------------------------------------
    console.log('\n' + '─'.repeat(60));
    console.log(' METABOLISM PROCESSOR');
    console.log('─'.repeat(60));

    const MetabolismProcessor = require('./lib/processor');
    const processor = new MetabolismProcessor(CONFIG, TEST_DIR);

    test('_formatConversation() truncates to last 10 messages', () => {
        const messages = [];
        for (let i = 0; i < 20; i++) {
            messages.push({ role: 'user', content: `Message ${i}` });
        }
        
        const formatted = processor._formatConversation(messages);
        const lines = formatted.split('\n\n');
        
        if (lines.length !== 10) {
            throw new Error(`Expected 10 messages, got ${lines.length}`);
        }
    });

    test('_parseImplications() filters correctly', () => {
        const response = `
implication: this is a header
format: this is meta

This is a real implication that is long enough to pass the filter.
This is another valid implication that demonstrates proper parsing.

[BRACKETED TEXT]
note: this is also a note
`;
        
        const implications = processor._parseImplications(response);
        
        if (implications.length !== 2) {
            throw new Error(`Expected 2 implications, got ${implications.length}: ${implications.join(' | ')}`);
        }
        
        console.log(`    Parsed: "${implications[0].substring(0, 50)}..."`);
    });

    test('_classifyVectorType() categorizes correctly', () => {
        const corrections = processor._classifyVectorType('When the user corrects me about the system');
        const procedural = processor._classifyVectorType('I should always check runtime before asserting');
        const pattern = processor._classifyVectorType('I notice a pattern in how the user asks questions');
        
        if (corrections !== 'user_correction') {
            throw new Error(`Expected user_correction, got ${corrections}`);
        }
        if (procedural !== 'procedural') {
            throw new Error(`Expected procedural, got ${procedural}`);
        }
        if (pattern !== 'pattern_recognition') {
            throw new Error(`Expected pattern_recognition, got ${pattern}`);
        }
        
        console.log(`    Types: correction=${corrections}, procedural=${procedural}, pattern=${pattern}`);
    });

    // LLM test (optional - requires Ollama)
    await asyncTest('LLM call extracts implications (requires Ollama)', async () => {
        const candidate = {
            id: 'test_llm',
            messages: [
                { role: 'user', content: 'I want you to investigate what a metabolism orchestrator would look like as an OpenClaw plugin. Make it lightweight.' },
                { role: 'assistant', content: 'The key insight is decoupling observation from processing. Fast path writes candidates, slow path processes during heartbeat. This preserves learning without runtime latency.' }
            ],
            entropy: 0.75
        };
        
        try {
            const result = await processor.processOne(candidate);
            
            if (!result.implications || result.implications.length === 0) {
                throw new Error('No implications extracted');
            }
            
            console.log(`    Extracted ${result.implications.length} implication(s)`);
            console.log(`    First: "${result.implications[0].substring(0, 80)}..."`);
            
            if (result.growthVectors.length > 0) {
                console.log(`    Growth vector: "${result.growthVectors[0].text.substring(0, 60)}..."`);
            }
        } catch (error) {
            if (error.message.includes('ECONNREFUSED') || error.message.includes('timed out')) {
                console.log(`    ⚠ Skipping: Ollama not available (${error.message})`);
                // Don't fail the test, just skip
                results.tests[results.tests.length - 1].status = 'SKIP';
                results.tests[results.tests.length - 1].error = 'Ollama not available';
            } else {
                throw error;
            }
        }
    }, 60000); // 60s timeout for LLM

    // ---------------------------------------------------------------------------
    // 3. Integration tests
    // ---------------------------------------------------------------------------
    console.log('\n' + '─'.repeat(60));
    console.log(' INTEGRATION');
    console.log('─'.repeat(60));

    test('Growth vectors file write works', () => {
        const gvPath = path.join(TEST_DIR, 'growth-vectors.json');
        
        // Simulate AgentState.writeGrowthVectors logic
        const vectors = [
            {
                id: 'gv_test',
                text: 'When the user mentions "lightweight", verify both latency and complexity cost',
                type: 'user_correction',
                validation_status: 'candidate'
            }
        ];
        
        let existing = { vectors: [], candidates: [] };
        if (fs.existsSync(gvPath)) {
            existing = JSON.parse(fs.readFileSync(gvPath, 'utf8'));
        }
        
        existing.candidates = existing.candidates || [];
        for (const v of vectors) {
            existing.candidates.push(v);
        }
        
        fs.writeFileSync(gvPath, JSON.stringify(existing, null, 2));
        
        // Verify
        const written = JSON.parse(fs.readFileSync(gvPath, 'utf8'));
        if (written.candidates.length !== vectors.length) {
            throw new Error(`Expected ${vectors.length} candidates, got ${written.candidates.length}`);
        }
        
        console.log(`    Wrote ${vectors.length} growth vector candidate(s)`);
    });

    // ---------------------------------------------------------------------------
    // Summary
    // ---------------------------------------------------------------------------
    console.log('\n' + '═'.repeat(60));
    console.log(' RESULTS');
    console.log('═'.repeat(60));
    console.log(`\n  Passed: ${results.passed}`);
    console.log(`  Failed: ${results.failed}`);
    console.log(`  Skipped: ${results.tests.filter(t => t.status === 'SKIP').length}\n`);

    results.tests.forEach(t => {
        const icon = t.status === 'PASS' ? '✓' : t.status === 'SKIP' ? '○' : '✗';
        console.log(`  ${icon} ${t.name}${t.error ? `: ${t.error}` : ''}`);
    });

    // Cleanup
    console.log('\n' + '─'.repeat(60));
    cleanup();
    console.log(' Cleaned up test directory');

    // Exit code
    process.exit(results.failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});