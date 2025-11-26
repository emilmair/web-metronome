import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, Volume2 } from 'lucide-react';

// DAW-grade metronome component
// - sample-accurate scheduling using AudioBufferSourceNode.start(time)
// - programmatic short samples (click/beep/wood) so no external files required
// - lookahead scheduler with 200ms scheduling window and 10ms interval
// - UI synced to AudioContext time via requestAnimationFrame for visual accuracy

export default function Metronome() {
    // ----- UI state -----
    const [bpm, setBpm] = useState(120);
    const [isPlaying, setIsPlaying] = useState(false);
    const isPlayingRef = useRef(false);
    const [subdivision, setSubdivision] = useState(4);
    const [sound, setSound] = useState('click');
    const [volume, setVolume] = useState(0.7);
    const [currentBeatUI, setCurrentBeatUI] = useState(0);
    const [downbeatDifferent, setDownbeatDifferent] = useState(true);

    // ----- Refs (stable across renders) -----
    const audioCtxRef = useRef(null);
    const masterGainRef = useRef(null);
    const samplesRef = useRef({}); // { click: AudioBuffer, beep: AudioBuffer, wood: AudioBuffer }

    const nextNoteTimeRef = useRef(0);
    const scheduleIntervalRef = useRef(null);
    const scheduledSourcesRef = useRef([]);
    const startTimeRef = useRef(0);
    const beatCountRef = useRef(0);
    const bpmRef = useRef(bpm);
    const subdivisionRef = useRef(subdivision);
    const soundRef = useRef(sound);
    const volumeRef = useRef(volume);
    const downbeatDifferentRef = useRef(downbeatDifferent);
    const rafRef = useRef(null);
    const rafTickRef = useRef(null);

    // ----- keep refs up-to-date -----
    useEffect(() => { bpmRef.current = bpm; }, [bpm]);
    useEffect(() => { subdivisionRef.current = subdivision; }, [subdivision]);
    useEffect(() => { soundRef.current = sound; }, [sound]);
    useEffect(() => { volumeRef.current = volume; if (masterGainRef.current) masterGainRef.current.gain.value = volume; }, [volume]);
    useEffect(() => { downbeatDifferentRef.current = downbeatDifferent; }, [downbeatDifferent]);

    // ----- create AudioContext on first user gesture -----
    const createAudioContext = () => {
        if (audioCtxRef.current) return audioCtxRef.current;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();

        const master = ctx.createGain();
        master.gain.value = volumeRef.current;
        master.connect(ctx.destination);

        audioCtxRef.current = ctx;
        masterGainRef.current = master;

        samplesRef.current = generateSamples(ctx);

        return ctx;
    };

    // ----- generate programmatic AudioBuffers -----
    const generateSamples = (ctx) => {
        const sr = ctx.sampleRate;

        function applyDecay(buffer, decayTime) {
            const data = buffer.getChannelData(0);
            const len = data.length;
            for (let i = 0; i < len; i++) {
                const t = i / sr;
                data[i] *= Math.max(0, 1 - t / decayTime);
            }
        }

        const clickDur = 0.06;
        const clickBuf = ctx.createBuffer(1, Math.floor(sr * clickDur), sr);
        {
            const data = clickBuf.getChannelData(0);
            const freq = 1200;
            for (let i = 0; i < data.length; i++) {
                const t = i / sr;
                data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-40 * t) + (Math.random() * 2 - 1) * Math.exp(-60 * t) * 0.1;
            }
            applyDecay(clickBuf, 0.06);
        }

        const beepDur = 0.12;
        const beepBuf = ctx.createBuffer(1, Math.floor(sr * beepDur), sr);
        {
            const data = beepBuf.getChannelData(0);
            const a4 = 440;
            for (let i = 0; i < data.length; i++) {
                const t = i / sr;
                data[i] = (Math.sin(2 * Math.PI * a4 * t) + 0.5 * Math.sin(2 * Math.PI * a4 * 2 * t)) * Math.exp(-8 * t);
            }
            applyDecay(beepBuf, 0.12);
        }

        const woodDur = 0.09;
        const woodBuf = ctx.createBuffer(1, Math.floor(sr * woodDur), sr);
        {
            const data = woodBuf.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                const t = i / sr;
                let val = 0;
                for (let h = 0; h < 6; h++) {
                    const freq = 200 + h * 60;
                    val += Math.sin(2 * Math.PI * freq * t + Math.random() * Math.PI * 2) * (1 / (h + 1));
                }
                data[i] = val * Math.exp(-20 * t);
            }
            applyDecay(woodBuf, 0.09);
        }

        return { click: clickBuf, beep: beepBuf, wood: woodBuf };
    };

    const scheduleBeat = (time, isAccent) => {
        const ctx = audioCtxRef.current;
        const samples = samplesRef.current;
        if (!ctx || !samples) return;

        const buf = (soundRef.current && samples[soundRef.current]) || samples.click;
        const src = ctx.createBufferSource();
        src.buffer = buf;

        // If the user enabled a different downbeat, increase pitch and loudness for the accented beat.
        const useDifferentDownbeat = isAccent && downbeatDifferentRef.current;
        // Raise pitch by 4 semitones (~1.26x) for the downbeat when enabled
        src.playbackRate.value = useDifferentDownbeat ? Math.pow(2, 4 / 12) : 1.0;

        const g = ctx.createGain();
        const accentGain = useDifferentDownbeat ? 1.4 : 0.6;
        g.gain.setValueAtTime(0.0001, time - 0.01);
        g.gain.linearRampToValueAtTime(volumeRef.current * accentGain, time + 0.001);
        g.gain.linearRampToValueAtTime(0.0001, time + 0.12);

        src.connect(g);
        g.connect(masterGainRef.current);

        src.start(time);
        scheduledSourcesRef.current.push({ src, time });

        const now = ctx.currentTime;
        scheduledSourcesRef.current = scheduledSourcesRef.current.filter(s => s.time > now - 1);
    };

    const scheduler = () => {
        const ctx = audioCtxRef.current;
        if (!ctx) return;

        const scheduleAheadTime = 0.2;
        const secondsPerBeat = 60.0 / bpmRef.current;

        while (nextNoteTimeRef.current < ctx.currentTime + scheduleAheadTime) {
            const isAccent = beatCountRef.current % subdivisionRef.current === 0;
            scheduleBeat(nextNoteTimeRef.current, isAccent);
            beatCountRef.current += 1;
            nextNoteTimeRef.current += secondsPerBeat;
        }
    };

    // Stable RAF tick stored in a ref to avoid changing identity across renders.
    if (!rafTickRef.current) {
        rafTickRef.current = function tick() {
            const ctx = audioCtxRef.current;
            if (!ctx || !isPlayingRef.current) return;

            const secondsPerBeat = 60.0 / bpmRef.current;
            const elapsed = ctx.currentTime - startTimeRef.current;
            if (elapsed >= 0) {
                const beatIndex = Math.floor(elapsed / secondsPerBeat) % subdivisionRef.current;
                setCurrentBeatUI((beatIndex + subdivisionRef.current) % subdivisionRef.current);
            }

            rafRef.current = requestAnimationFrame(rafTickRef.current);
        };
    }

    const startMetronome = async () => {
        const ctx = createAudioContext();
        await ctx.resume();

        beatCountRef.current = 0;
        startTimeRef.current = ctx.currentTime + 0.06;
        nextNoteTimeRef.current = startTimeRef.current;

        scheduleIntervalRef.current = setInterval(scheduler, 10);
        rafRef.current = requestAnimationFrame(rafTickRef.current);

        setIsPlaying(true);
        isPlayingRef.current = true;
    };

    const stopMetronome = () => {
        const ctx = audioCtxRef.current;

        if (scheduleIntervalRef.current) {
            clearInterval(scheduleIntervalRef.current);
            scheduleIntervalRef.current = null;
        }

        if (ctx) {
            const now = ctx.currentTime;
            scheduledSourcesRef.current.forEach(({ src, time }) => {
                if (time > now) {
                    try { src.stop(0); } catch (e) { }
                }
            });
        }

        scheduledSourcesRef.current = [];

        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }

        setIsPlaying(false);
        isPlayingRef.current = false;
        setCurrentBeatUI(0);
    };

    const toggleMetronome = () => {
        if (isPlaying) stopMetronome();
        else startMetronome();
    };

    useEffect(() => {
        return () => {
            if (scheduleIntervalRef.current) clearInterval(scheduleIntervalRef.current);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (audioCtxRef.current) audioCtxRef.current.close();
        };
    }, []);

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
            <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl shadow-2xl p-8 w-full max-w-md border border-slate-700">
                <h1 className="text-4xl font-bold text-center mb-6 text-white">Metronome</h1>

                <div className="text-center mb-6">
                    <div className="text-6xl font-bold text-purple-400 mb-2">{bpm}</div>
                    <div className="text-slate-400 text-sm uppercase tracking-wider">BPM</div>
                </div>

                <div className="mb-6">
                    <label className="block text-slate-300 mb-2 text-sm font-medium">Tempo</label>
                    <input type="range" min="40" max="240" value={bpm} onChange={(e) => setBpm(Number(e.target.value))} className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                    <div className="flex justify-between text-xs text-slate-500 mt-1"><span>40</span><span>240</span></div>
                </div>

                <div className="mb-6">
                    <div className="flex justify-center gap-2">
                        {[...Array(subdivision)].map((_, i) => (
                            <div key={i} className={`w-10 h-10 rounded-full transition-all duration-80 ${isPlaying && currentBeatUI === i ? (i === 0 ? 'bg-purple-400 shadow-lg shadow-purple-500/50 scale-110' : 'bg-blue-400 shadow-lg shadow-blue-500/50 scale-110') : 'bg-slate-700'}`} />
                        ))}
                    </div>
                </div>

                <button onClick={toggleMetronome} className={`w-full py-4 rounded-xl font-semibold text-lg mb-4 transition-all duration-200 flex items-center justify-center gap-2 ${isPlaying ? 'bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-500/30' : 'bg-purple-500 hover:bg-purple-600 text-white shadow-lg shadow-purple-500/30'}`}>
                    {isPlaying ? (<><Pause size={20} /> Stop</>) : (<><Play size={20} /> Start</>)}
                </button>

                <div className="mb-4">
                    <label className="block text-slate-300 mb-2 text-sm font-medium">Beats per Measure</label>
                    <div className="grid grid-cols-4 gap-2">
                        {[2, 3, 4, 6].map(s => (
                            <button key={s} onClick={() => setSubdivision(s)} className={`py-3 rounded-lg font-semibold transition-all ${subdivision === s ? 'bg-purple-500 text-white shadow-md' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>{s}</button>
                        ))}
                    </div>
                </div>

                <div className="mb-4">
                    <label className="block text-slate-300 mb-2 text-sm font-medium flex items-center gap-2"><Volume2 size={14} /> Sound</label>
                    <div className="grid grid-cols-3 gap-2">
                        {['click', 'beep', 'wood'].map(s => (
                            <button key={s} onClick={() => setSound(s)} className={`py-3 rounded-lg font-semibold capitalize transition-all ${sound === s ? 'bg-purple-500 text-white shadow-md' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>{s}</button>
                        ))}
                    </div>
                </div>

                <div className="mb-4">
                    <label className="flex items-center gap-3 text-sm text-slate-300">
                        <input type="checkbox" checked={downbeatDifferent} onChange={(e) => setDownbeatDifferent(e.target.checked)} className="h-4 w-4 rounded bg-slate-700" />
                        <span className="font-medium">Accentuate downbeat</span>
                        {/* <span className="text-xs text-slate-500">(louder & higher pitch)</span> */}
                    </label>
                </div>

                <div>
                    <label className="block text-slate-300 mb-2 text-sm font-medium">Volume</label>
                    <input type="range" min="0" max="1" step="0.01" value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer" />
                </div>

            </div>
        </div>
    );
}
