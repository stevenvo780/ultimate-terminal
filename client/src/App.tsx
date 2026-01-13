import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './App.css';

interface Worker {
  id: string;
  socketId: string;
  name: string;
}

const NEXUS_URL = 'http://localhost:3002';

function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  
  // Refs for callbacks to avoid stale closures without re-init
  const socketRef = useRef<Socket | null>(null);
  const selectedWorkerRef = useRef<string | null>(null);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    selectedWorkerRef.current = selectedWorkerId;
    // Clear terminal when switching workers (optional, maybe we want history?)
    // xtermRef.current?.reset(); 
  }, [selectedWorkerId]);

  useEffect(() => {
    const newSocket = io(NEXUS_URL);
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('Connected to Nexus');
      newSocket.emit('register', { type: 'client' });
    });

    newSocket.on('worker-list', (list: Worker[]) => {
      console.log('Workers:', list);
      setWorkers(list);
      if (!selectedWorkerRef.current && list.length > 0) {
        setSelectedWorkerId(list[0].id);
      }
    });

    newSocket.on('output', (data: { workerId: string, data: string }) => {
      // Write to terminal if it matches selected worker
      // Or if we want to monitor all, maybe prefix?
      // For now, strict match.
      // Note: We access current ref value here.
      if (selectedWorkerRef.current && data.workerId === selectedWorkerRef.current) {
        xtermRef.current?.write(data.data);
      }
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Initialize Xterm
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"MesloLGS NF", "Fira Code", "JetBrains Mono", "Roboto Mono", "Monaco", "Courier New", monospace',
      fontSize: 14,
      allowTransparency: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#ffffff',
      }
    });
    
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    term.open(terminalRef.current);
    fitAddon.fit();
    
    xtermRef.current = term;

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    // Handle Input
    term.onData((data) => {
      if (socketRef.current && selectedWorkerRef.current) {
        socketRef.current.emit('execute', {
          workerId: selectedWorkerRef.current,
          command: data
        });
      }
    });

    return () => {
      term.dispose();
      window.removeEventListener('resize', handleResize);
    };
  }, []); // Run once on mount

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#000', color: '#fff' }}>
      <div style={{ padding: '10px 20px', background: '#333', display: 'flex', gap: '20px', alignItems: 'center', borderBottom: '1px solid #444' }}>
        <h3 style={{ margin: 0 }}>Ultimate Terminal</h3>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label>Worker:</label>
            <select 
            value={selectedWorkerId || ''} 
            onChange={(e) => setSelectedWorkerId(e.target.value)}
            style={{ padding: '5px', borderRadius: '4px', background: '#222', color: '#fff', border: '1px solid #555' }}
            >
            <option value="" disabled>Select a Worker</option>
            {workers.map(w => (
                <option key={w.id} value={w.id}>{w.name}</option>
            ))}
            </select>
        </div>

        <div style={{ marginLeft: 'auto', fontSize: '0.8rem', color: socket?.connected ? '#4caf50' : '#f44336' }}>
            {socket?.connected ? '● Connected' : '○ Disconnected'}
        </div>
      </div>
      
      <div 
        ref={terminalRef} 
        style={{ flex: 1, overflow: 'hidden', padding: '5px' }} 
        className="terminal-container"
      />
    </div>
  );
}

export default App;