import { Accordion, AccordionDetails, AccordionSummary, Box, Button, Chip, Typography } from '@mui/material';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TerminalIcon from '@mui/icons-material/Terminal';

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
            fontWeight: 700,
            textTransform: 'none',
          }}
        >
          {isStopping ? 'Stopping...' : 'Stop Simulation'}
        </Button>
      </Box>

      {logs && (
        <Accordion disableGutters elevation={0} sx={{ mt: 1, border: '1px solid #333', borderRadius: 1, '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon fontSize="small" />} sx={{ minHeight: 36, px: 1.5, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <TerminalIcon sx={{ fontSize: 14, color: '#4caf50' }} />
              <Typography variant="caption" fontWeight={600} sx={{ color: 'text.secondary', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                Execution Logs
              </Typography>
              <Chip label="stdout" size="small" sx={{ height: 16, fontSize: 9, fontFamily: 'monospace', bgcolor: '#1a2a1a', color: '#4caf50', border: '1px solid #2e5c2e' }} />
            </Box>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 0 }}>
            <Box sx={{
              p: 1,
              bgcolor: '#121212',
              maxHeight: '150px',
              overflowY: 'auto',
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
              sx={{ mx: 1, mb: 0.5, textTransform: 'none' }}
              onClick={onClearLogs}
            >
              Clear Logs
            </Button>
          </AccordionDetails>
        </Accordion>
      )}
    </Box>
  );
}