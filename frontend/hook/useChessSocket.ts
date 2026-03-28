import { useEffect, useRef, useState, useCallback } from "react";

export type ChessSocketStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

interface ChessMove {
  from: string;
  to: string;
  promotion?: string;
}

interface UseChessSocketReturn {
  status: ChessSocketStatus;
  gameId: string | null;
  lastOpponentMove: ChessMove | null;
  sendMove: (move: ChessMove) => void;
  disconnect: () => void;
  reconnect: () => void;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const WS_BASE = API_BASE.replace(/^http/, "ws");

// Exponential backoff configuration
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const RECONNECT_TIMEOUT = 3000; // 3 seconds timeout for reconnection

export function useChessSocket(gameId: string | null): UseChessSocketReturn {
  const [status, setStatus] = useState<ChessSocketStatus>("idle");
  const [lastOpponentMove, setLastOpponentMove] = useState<ChessMove | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const moveQueueRef = useRef<ChessMove[]>([]);
  const isManualDisconnectRef = useRef(false);
  const isOnlineRef = useRef(typeof navigator !== 'undefined' ? navigator.onLine : true);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const calculateReconnectDelay = useCallback((attempt: number): number => {
    const baseDelay = INITIAL_RECONNECT_DELAY * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * baseDelay; // Add 0-30% jitter
    const delay = baseDelay + jitter;
    return Math.min(delay, MAX_RECONNECT_DELAY);
  }, []);

  const createWebSocket = useCallback((attemptReconnect = false): WebSocket | null => {
    if (!gameId) return null;

    try {
      const ws = new WebSocket(`${WS_BASE}/v1/games/${gameId}/ws`);
      wsRef.current = ws;

      if (attemptReconnect) {
        setStatus("reconnecting");
        console.log(`[WebSocket] Attempting reconnection for game ${gameId}`);
      } else {
        setStatus("connecting");
        console.log(`[WebSocket] Connecting to game ${gameId}`);
      }

      ws.onopen = () => {
        console.log(`[WebSocket] ${attemptReconnect ? 'Reconnected' : 'Connected'} for game ${gameId}`);
        setStatus("connected");
        reconnectAttemptsRef.current = 0;
        
        // Send queued moves immediately upon reconnection
        if (moveQueueRef.current.length > 0) {
          console.log(`[WebSocket] Dispatching ${moveQueueRef.current.length} queued moves`);
          moveQueueRef.current.forEach(move => {
            ws.send(JSON.stringify({ 
              type: "move", 
              gameId, 
              from: move.from, 
              to: move.to, 
              promotion: move.promotion 
            }));
          });
          moveQueueRef.current = [];
        }

        // Request board state sync after reconnection
        if (attemptReconnect) {
          console.log(`[WebSocket] Requesting board state sync for game ${gameId}`);
          ws.send(JSON.stringify({ type: "sync", gameId }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "move") {
            console.log(`[WebSocket] Received opponent move:`, data);
            setLastOpponentMove({
              from: data.from,
              to: data.to,
              promotion: data.promotion,
            });
          } else if (data.type === "sync") {
            console.log(`[WebSocket] Received board state sync:`, data);
            // Handle sync response - this could update the board state
            // The parent component should handle this via lastOpponentMove or a separate callback
          }
        } catch (error) {
          console.error("[WebSocket] Failed to parse message:", error);
        }
      };

      ws.onerror = (error) => {
        console.error("[WebSocket] Error:", error);
        setStatus("error");
      };

      ws.onclose = (event) => {
        console.log(`[WebSocket] Closed for game ${gameId}. Code: ${event.code}, Reason: ${event.reason}`);
        
        if (!isManualDisconnectRef.current) {
          setStatus("disconnected");
          
          // Check if we're online before attempting reconnection
          if (!isOnlineRef.current) {
            console.log("[WebSocket] Device is offline, waiting for network...");
            return;
          }
          
          // Inline reconnection logic to avoid circular dependency
          if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
            const delay = calculateReconnectDelay(reconnectAttemptsRef.current);
            console.log(`[WebSocket] Attempting reconnection ${reconnectAttemptsRef.current + 1}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay)}ms`);
            
            reconnectTimeoutRef.current = setTimeout(() => {
              reconnectAttemptsRef.current++;
              createWebSocket(true);
            }, delay);

            // Set a timeout to ensure reconnection completes within 3 seconds
            reconnectTimerRef.current = setTimeout(() => {
              if (status === "reconnecting") {
                console.log("[WebSocket] Reconnection timeout exceeded 3 seconds");
                // Continue trying but log the timeout
              }
            }, RECONNECT_TIMEOUT);
          } else {
            console.log("[WebSocket] Max reconnection attempts reached");
            setStatus("error");
          }
        } else {
          setStatus("idle");
          isManualDisconnectRef.current = false;
        }
      };

      return ws;
    } catch (error) {
      console.error("[WebSocket] Failed to create:", error);
      setStatus("error");
      return null;
    }
  }, [gameId, calculateReconnectDelay, status]);

  const sendMove = useCallback((move: ChessMove) => {
    // If WebSocket is open, send immediately
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ 
        type: "move", 
        gameId, 
        from: move.from, 
        to: move.to, 
        promotion: move.promotion 
      }));
      console.log("[WebSocket] Move sent immediately:", move);
    } else {
      // Queue the move for when we reconnect
      moveQueueRef.current.push(move);
      console.log("[WebSocket] Move queued (disconnected):", move);
      
      // Start reconnection if not already attempting
      if (status === "disconnected" || status === "idle") {
        reconnectAttemptsRef.current = 0;
        createWebSocket(true);
      }
    }
  }, [gameId, status, createWebSocket]);

  const disconnect = useCallback(() => {
    isManualDisconnectRef.current = true;
    clearReconnectTimeout();
    
    if (wsRef.current) {
      wsRef.current.close(1000, "Manual disconnect");
      wsRef.current = null;
    }
    
    // Clear move queue on manual disconnect
    moveQueueRef.current = [];
    reconnectAttemptsRef.current = 0;
    console.log("[WebSocket] Manually disconnected");
  }, [clearReconnectTimeout]);

  const reconnect = useCallback(() => {
    isManualDisconnectRef.current = false;
    clearReconnectTimeout();
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    reconnectAttemptsRef.current = 0;
    console.log("[WebSocket] Manual reconnection initiated");
    createWebSocket(true);
  }, [clearReconnectTimeout, createWebSocket]);

  // Handle online/offline events
  useEffect(() => {
    const handleOnline = () => {
      console.log("[Network] Device is online");
      isOnlineRef.current = true;
      
      // If we were disconnected and are now online, attempt reconnection
      if (status === "disconnected" && gameId) {
        console.log("[Network] Online detected, attempting reconnection...");
        reconnectAttemptsRef.current = 0;
        createWebSocket(true);
      }
    };

    const handleOffline = () => {
      console.log("[Network] Device is offline");
      isOnlineRef.current = false;
      
      // Clear any pending reconnection attempts
      clearReconnectTimeout();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
    };
  }, [status, gameId, createWebSocket, clearReconnectTimeout]);

  // Initialize WebSocket when gameId changes
  useEffect(() => {
    if (gameId) {
      const ws = createWebSocket();
      return () => {
        isManualDisconnectRef.current = true;
        clearReconnectTimeout();
        if (ws) {
          ws.close();
        }
      };
    } else {
      setStatus("idle");
      setLastOpponentMove(null);
    }
  }, [gameId, createWebSocket, clearReconnectTimeout]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearReconnectTimeout();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [clearReconnectTimeout]);

  return {
    status,
    gameId,
    lastOpponentMove,
    sendMove,
    disconnect,
    reconnect,
  };
}
