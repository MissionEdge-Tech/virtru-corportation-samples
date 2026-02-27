import { Box, Button, Typography } from '@mui/material';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopCircleIcon from '@mui/icons-material/StopCircle';

interface SimulationPanelProps {
  isStarting: boolean;
  isStopping: boolean;
  isRunning: boolean;
  logs: string | null;
  onStart: () => void;
  onStop: () => void;
  onClearLogs: () => void;
}

export function SimulationPanel({
  isStarting,
  isStopping,
  isRunning,
  logs,
  onStart,
  onStop,
  onClearLogs,
}: SimulationPanelProps) {
  return (
    <Box sx={{
      mb: 3,
      p: 2,
      border: '1px solid',
      borderColor: 'divider',
      borderRadius: 1,
      bgcolor: 'background.paper',
    }}>
      <Typography
        variant="subtitle2"
        fontWeight={700}
        gutterBottom
        sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
      >
        <TrendingUpIcon fontSize="small" color="primary" />
        Data Orchestration
      </Typography>

      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          fullWidth
          variant="contained"
          color="success"
          onClick={onStart}
          disabled={isStarting || isRunning}
          startIcon={isStarting ? undefined : <PlayArrowIcon />}
          sx={{
            mb: logs ? 1 : 0,
            fontWeight: 700,
            textTransform: 'none',
          }}
        >
          {isStarting ? 'Starting...' : isRunning ? 'Running' : 'Start Simulation'}
        </Button>

        <Button
          fullWidth
          variant="contained"
          color="error"
          onClick={onStop}
          disabled={isStopping || !isRunning}
          startIcon={isStopping ? undefined : <StopCircleIcon />}
          sx={{
            mb: logs ? 1 : 0,
            fontWeight: 700,
            textTransform: 'none',
          }}
        >
          {isStopping ? 'Stopping...' : 'Stop Simulation'}
        </Button>
      </Box>

      {logs && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Execution Logs:
          </Typography>
          <Box sx={{
            p: 1,
            bgcolor: '#121212',
            borderRadius: 1,
            maxHeight: '150px',
            overflowY: 'auto',
            border: '1px solid #333',
          }}>
            <pre style={{
              margin: 0,
              fontSize: '10px',
              color: '#4caf50',
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
            }}>
              {logs}
            </pre>
          </Box>
          <Button
            size="small"
            sx={{ mt: 0.5, textTransform: 'none' }}
            onClick={onClearLogs}
          >
            Clear Logs
          </Button>
        </Box>
      )}
    </Box>
  );
}