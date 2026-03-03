import { useState, useCallback } from 'react';
import { useRpcClient } from '@/hooks/useRpcClient';

interface UseSimulationOptions {
  onStartSuccess?: () => void;
}

export function useSimulation({ onStartSuccess }: UseSimulationOptions = {}) {
  const { runPythonScript } = useRpcClient();

  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);

  const start = useCallback(async () => {
    setIsStarting(true);
    setLogs('Executing sequence: seed_data -> launch simulation...');

    try {
      const response = await runPythonScript({
        scriptId: 'simulation_start',
        args: [],
      });

      setLogs(response.output);

      if (response.exitCode === 0) {
        setIsRunning(true);
        onStartSuccess?.();
      }
    } catch (err) {
      console.error('Start simulation failed:', err);
      setLogs('Network error: Failed to start simulation.');
    } finally {
      setIsStarting(false);
    }
  }, [runPythonScript, onStartSuccess]);

  const stop = useCallback(async () => {
    setIsStopping(true);
    setLogs('Stopping simulation...');

    try {
      const response = await runPythonScript({
        scriptId: 'simulation_stop',
        args: [],
      });

      setLogs(response.output);
      setIsRunning(false);
    } catch (err) {
      console.error('Stop simulation failed:', err);
      setLogs('Network error: Failed to stop simulation.');
    } finally {
      setIsStopping(false);
    }
  }, [runPythonScript]);

  const clearLogs = useCallback(() => setLogs(null), []);

  return { isStarting, isStopping, isRunning, logs, start, stop, clearLogs };
}