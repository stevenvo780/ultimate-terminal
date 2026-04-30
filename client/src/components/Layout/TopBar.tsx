import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import {
  logoutAndReset,
  assignGridSlot,
  moveSession,
  setShowChangePasswordModal,
  setShowSubscriptionModal,
  setShowSettings,
  setShowUserMenu,
  setShowMobileSidebar,
  setActiveSession,
  setRenamingSessionId,
  setShowWorkerModal,
  setEditingWorker,
} from '../../store';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  CreditCard,
  KeyRound,
  LogOut,
  Maximize2,
  Menu,
  Minimize2,
  MoreHorizontal,
  Play,
  Settings,
  Smartphone,
  User,
  Hexagon,
} from 'lucide-react';
import './TopBar.css';

interface TopBarProps {
  onResume: () => void;
  onFullscreen: () => void;
  onInstallPWA: () => void;
  installPromptAvailable: boolean;
  onCloseSession: (sessionId: string) => void;
  onDragStart: (sessionId: string, displayName: string, event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

export function TopBar({
  onResume,
  onFullscreen,
  onInstallPWA,
  installPromptAvailable,
  onCloseSession,
  onDragStart,
  onDragEnd,
}: TopBarProps) {
  const dispatch = useAppDispatch();
  const workers = useAppSelector((state) => state.workers.workers);
  const sessions = useAppSelector((state) => state.sessions.sessions);
  const activeSessionId = useAppSelector((state) => state.sessions.activeSessionId);
  const draggingSessionId = useAppSelector((state) => state.sessions.draggingSessionId);
  const gridSessionIds = useAppSelector((state) => state.sessions.gridSessionIds);
  const connectionState = useAppSelector((state) => state.connection.connectionState);
  const currentUser = useAppSelector((state) => state.auth.currentUser);
  const token = useAppSelector((state) => state.auth.token);
  const showUserMenu = useAppSelector((state) => state.ui.showUserMenu);
  const isFullscreen = useAppSelector((state) => state.ui.isFullscreen);
  const showSettingsMenu = useAppSelector((state) => state.ui.showSettings);
  const showMobileSidebar = useAppSelector((state) => state.ui.showMobileSidebar);
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [sessionMenuPosition, setSessionMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const sessionMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const sessionsStripRef = useRef<HTMLDivElement | null>(null);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 1100);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [tabDropTarget, setTabDropTarget] = useState<string | null>(null);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 1100);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!showMobileSidebar) return;
    setShowMobileMenu(false);
    setSessionMenuId(null);
    dispatch(setShowSettings(false));
    dispatch(setShowUserMenu(false));
  }, [dispatch, showMobileSidebar]);

  const closeTransientMenus = useCallback(() => {
    setShowMobileMenu(false);
    setSessionMenuId(null);
    dispatch(setShowSettings(false));
    dispatch(setShowUserMenu(false));
  }, [dispatch]);

  const handleToggleUserMenu = () => {
    dispatch(setShowMobileSidebar(false));
    setShowMobileMenu(false);
    setSessionMenuId(null);
    dispatch(setShowUserMenu(!showUserMenu));
    if (!showUserMenu) {
      dispatch(setShowSettings(false));
    }
  };

  const handleToggleSettingsMenu = () => {
    dispatch(setShowMobileSidebar(false));
    setShowMobileMenu(false);
    setSessionMenuId(null);
    dispatch(setShowSettings(!showSettingsMenu));
    if (!showSettingsMenu) {
      dispatch(setShowUserMenu(false));
    }
  };

  const handleInstallWorker = () => {
    closeTransientMenus();
    dispatch(setEditingWorker(null));
    dispatch(setShowWorkerModal(true));
    dispatch(setShowSettings(false));
  };

  const handleFullscreenToggle = () => {
    onFullscreen();
    closeTransientMenus();
    dispatch(setShowSettings(false));
  };

  const handleInstallPWA = () => {
    if (!installPromptAvailable) return;
    onInstallPWA();
    closeTransientMenus();
    dispatch(setShowSettings(false));
  };

  const handleChangePassword = () => {
    closeTransientMenus();
    dispatch(setShowChangePasswordModal(true));
    dispatch(setShowUserMenu(false));
  };

  const handleLogout = () => {
    closeTransientMenus();
    dispatch(logoutAndReset());
    dispatch(setShowUserMenu(false));
  };

  const handleSessionMenuToggle = (sessionId: string) => {
    dispatch(setShowMobileSidebar(false));
    setShowMobileMenu(false);
    dispatch(setShowSettings(false));
    dispatch(setShowUserMenu(false));
    setSessionMenuId((current) => {
      if (current === sessionId) {
        setSessionMenuPosition(null);
        return null;
      }
      return sessionId;
    });
  };

  const activeSessionMenu = useMemo(
    () => sessions.find((session) => session.id === sessionMenuId) || null,
    [sessions, sessionMenuId]
  );

  const updateSessionMenuPosition = useCallback(() => {
    const anchor = sessionMenuAnchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 200;
    const left = Math.min(rect.left, window.innerWidth - menuWidth - 8);
    setSessionMenuPosition({
      top: rect.bottom + 6,
      left: Math.max(8, left),
    });
  }, []);

  useLayoutEffect(() => {
    if (!sessionMenuId) return;
    updateSessionMenuPosition();
    const handleWindow = () => updateSessionMenuPosition();
    const strip = sessionsStripRef.current;
    window.addEventListener('resize', handleWindow);
    window.addEventListener('scroll', handleWindow, true);
    strip?.addEventListener('scroll', handleWindow);
    return () => {
      window.removeEventListener('resize', handleWindow);
      window.removeEventListener('scroll', handleWindow, true);
      strip?.removeEventListener('scroll', handleWindow);
    };
  }, [sessionMenuId, updateSessionMenuPosition]);

  const handleSendToGrid = (sessionId: string) => {
    const emptyIdx = gridSessionIds.findIndex((id) => !id);
    const slotIndex = emptyIdx >= 0 ? emptyIdx : gridSessionIds.length;
    dispatch(assignGridSlot({ slotIndex, sessionId }));
    setSessionMenuId(null);
  };

  const handleTabDragOver = (targetSessionId: string) => (event: React.DragEvent<HTMLDivElement>) => {
    // Allow drop if we're dragging a session (check dataTransfer types as fallback for Redux timing)
    const isSessionDrag = draggingSessionId || event.dataTransfer.types.includes('text/plain');
    if (!isSessionDrag) return;
    if (draggingSessionId === targetSessionId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setTabDropTarget(targetSessionId);
  };

  const handleTabDrop = (targetSessionId: string) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const sessionId = event.dataTransfer.getData('text/plain') || draggingSessionId;
    if (!sessionId || sessionId === targetSessionId) {
      setTabDropTarget(null);
      return;
    }

    dispatch(moveSession({ sessionId, targetSessionId }));
    setTabDropTarget(null);
  };

  const handleSessionsStripDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.target !== event.currentTarget) {
      return;
    }
    const sessionId = event.dataTransfer.getData('text/plain') || draggingSessionId;
    if (!sessionId) {
      setTabDropTarget(null);
      return;
    }

    dispatch(moveSession({ sessionId, position: 'end' }));
    setTabDropTarget(null);
  };

  const handleTabDragEnd = () => {
    setTabDropTarget(null);
    onDragEnd();
  };

  const currentSessionIndex = useMemo(
    () => sessions.findIndex((s) => s.id === activeSessionId),
    [sessions, activeSessionId]
  );

  const goToPrevSession = useCallback(() => {
    if (currentSessionIndex <= 0) return;
    const target = sessions[currentSessionIndex - 1];
    if (target) {
      dispatch(setActiveSession(target.id));
      sessionsStripRef.current
        ?.querySelector(`[data-session-id="${target.id}"]`)
        ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [currentSessionIndex, sessions, dispatch]);

  const goToNextSession = useCallback(() => {
    if (currentSessionIndex < 0 || currentSessionIndex >= sessions.length - 1) return;
    const target = sessions[currentSessionIndex + 1];
    if (target) {
      dispatch(setActiveSession(target.id));
      sessionsStripRef.current
        ?.querySelector(`[data-session-id="${target.id}"]`)
        ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [currentSessionIndex, sessions, dispatch]);

  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-icon">
          <Hexagon />
        </span>
      </div>

      {isMobile && sessions.length > 1 && (
        <button
          className="icon-btn topbar-session-nav"
          onClick={goToPrevSession}
          disabled={currentSessionIndex <= 0}
          title="Sesión anterior"
          type="button"
        >
          <ChevronLeft />
        </button>
      )}

      <div
        className="topbar-sessions"
        ref={sessionsStripRef}
        onDragOver={(event) => {
          if (!draggingSessionId && !event.dataTransfer.types.includes('text/plain')) return;
          event.preventDefault();
        }}
        onDrop={handleSessionsStripDrop}
      >
        {sessions.map((session) => (
          <div
            key={session.id}
            data-session-id={session.id}
            className={`session-chip ${activeSessionId === session.id ? 'active' : ''} ${tabDropTarget === session.id ? 'drop-target' : ''}`}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', session.id);
              event.dataTransfer.setData('application/x-session-name', session.displayName);
              event.dataTransfer.effectAllowed = 'move';
              onDragStart(session.id, session.displayName, event);
            }}
            onDragOver={handleTabDragOver(session.id)}
            onDrop={handleTabDrop(session.id)}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setTabDropTarget((current) => current === session.id ? null : current);
              }
            }}
            onDragEnd={handleTabDragEnd}
          >
            <button
              className="session-chip-main"
              onClick={() => {
                dispatch(setActiveSession(session.id));
                setSessionMenuId(null);
              }}
              type="button"
              title={session.displayName}
            >
              <span className="session-chip-name">{session.displayName}</span>
            </button>
            <button
              className="session-chip-menu-btn"
              onClick={(event) => {
                event.stopPropagation();
                sessionMenuAnchorRef.current = event.currentTarget;
                handleSessionMenuToggle(session.id);
              }}
              title="Opciones"
              type="button"
            >
              <MoreHorizontal />
            </button>
          </div>
        ))}
      </div>

      {isMobile && sessions.length > 1 && (
        <button
          className="icon-btn topbar-session-nav"
          onClick={goToNextSession}
          disabled={currentSessionIndex < 0 || currentSessionIndex >= sessions.length - 1}
          title="Sesión siguiente"
          type="button"
        >
          <ChevronRight />
        </button>
      )}

      {activeSessionMenu && sessionMenuPosition && createPortal(
        <>
          {isMobile && <div className="mobile-menu-backdrop" onClick={() => setSessionMenuId(null)} />}
          <div
            className="session-chip-menu floating"
            style={{ top: `${sessionMenuPosition.top}px`, left: `${sessionMenuPosition.left}px` }}
          >
            <button
              className="session-chip-menu-item"
              onClick={() => {
                dispatch(setRenamingSessionId(activeSessionMenu.id));
                setSessionMenuId(null);
              }}
              type="button"
            >
              Renombrar
            </button>
            <button
              className="session-chip-menu-item"
              onClick={() => handleSendToGrid(activeSessionMenu.id)}
              type="button"
            >
              Enviar al grid
            </button>
            <button
              className="session-chip-menu-item danger"
              onClick={() => {
                onCloseSession(activeSessionMenu.id);
                setSessionMenuId(null);
              }}
              type="button"
            >
              Cerrar sesión
            </button>
          </div>
        </>,
        document.body
      )}

      <div className="topbar-stats">
        <span>{sessions.length} sesion{sessions.length !== 1 ? 'es' : ''}</span>
        <span>•</span>
        <span>{workers.length} worker{workers.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="topbar-right">
        {/* === MOBILE: single unified menu button === */}
        {isMobile ? (
          <div className="mobile-menu-container">
            {activeSessionId && (
              <button className="icon-btn resume-btn" onClick={onResume} title="Reanudar sesión activa">
                <Play />
              </button>
            )}
            <div className={`status-dot ${connectionState === 'connected' ? 'ok' :
              connectionState === 'reconnecting' || connectionState === 'connecting' ? 'warn' : 'bad'
              }`} title={
                connectionState === 'connected' ? 'Conectado' :
                  connectionState === 'connecting' ? 'Conectando...' :
                    connectionState === 'reconnecting' ? 'Reconectando...' : 'Desconectado'
              }>
            </div>
            <button
              className={`icon-btn mobile-menu-btn ${showMobileMenu ? 'active' : ''}`}
              onClick={() => {
                dispatch(setShowMobileSidebar(false));
                dispatch(setShowSettings(false));
                dispatch(setShowUserMenu(false));
                setShowMobileMenu(!showMobileMenu);
                setSessionMenuId(null);
              }}
              title="Menú"
            >
              <Menu />
            </button>
            {showMobileMenu && createPortal(
              <>
                <div className="mobile-menu-backdrop" onClick={() => setShowMobileMenu(false)} />
                <div className="user-menu-dropdown mobile-unified-menu">
                {currentUser && (
                  <div className="user-menu-header">
                    <span className="user-menu-username">{currentUser.username}</span>
                    {currentUser.isAdmin && <span className="user-menu-badge">Admin</span>}
                  </div>
                )}
                <button className="user-menu-item" onClick={() => { handleChangePassword(); setShowMobileMenu(false); }}>
                  <KeyRound className="menu-icon" />
                  <span>Cambiar Contraseña</span>
                </button>
                <button className="user-menu-item" onClick={() => {
                  dispatch(setShowSubscriptionModal(true));
                  setShowMobileMenu(false);
                }}>
                  <CreditCard className="menu-icon" />
                  <span>Suscripción</span>
                </button>
                <div className="mobile-menu-divider" />
                <button className="user-menu-item" onClick={() => { handleInstallWorker(); setShowMobileMenu(false); }}>
                  <Download className="menu-icon" />
                  <span>Instalar worker</span>
                </button>
                <button className="user-menu-item" onClick={() => { handleFullscreenToggle(); setShowMobileMenu(false); }}>
                  {isFullscreen ? <Minimize2 className="menu-icon" /> : <Maximize2 className="menu-icon" />}
                  <span>{isFullscreen ? 'Salir pantalla completa' : 'Pantalla completa'}</span>
                </button>
                <button
                  className="user-menu-item"
                  onClick={() => { handleInstallPWA(); setShowMobileMenu(false); }}
                  disabled={!installPromptAvailable}
                >
                  <Smartphone className="menu-icon" />
                  <span>{installPromptAvailable ? 'Instalar PWA' : 'PWA no disponible'}</span>
                </button>
                <div className="mobile-menu-divider" />
                <button className="user-menu-item logout" onClick={() => { handleLogout(); setShowMobileMenu(false); }}>
                  <LogOut className="menu-icon" />
                  <span>Cerrar Sesión</span>
                </button>
              </div>
              </>,
              document.body
            )}
          </div>
        ) : (
          /* === DESKTOP: individual buttons === */
          <>
            {activeSessionId && (
              <button className="icon-btn resume-btn" onClick={onResume} title="Reanudar sesión activa">
                <Play />
              </button>
            )}

            <div className={`status-dot ${connectionState === 'connected' ? 'ok' :
              connectionState === 'reconnecting' || connectionState === 'connecting' ? 'warn' : 'bad'
              }`} title={
                connectionState === 'connected' ? 'Conectado' :
                  connectionState === 'connecting' ? 'Conectando...' :
                    connectionState === 'reconnecting' ? 'Reconectando...' : 'Desconectado'
              }>
            </div>

            {token && currentUser && (
              <div className="user-menu-container">
                <button
                  className="icon-btn user-btn"
                  onClick={handleToggleUserMenu}
                  title={currentUser.username}
                >
                  <User />
                </button>
                {showUserMenu && (
                  <div className="user-menu-dropdown">
                    <div className="user-menu-header">
                      <span className="user-menu-username">{currentUser.username}</span>
                      {currentUser.isAdmin && <span className="user-menu-badge">Admin</span>}
                    </div>
                    <button
                      className="user-menu-item"
                      onClick={handleChangePassword}
                    >
                      <KeyRound className="menu-icon" />
                      <span>Cambiar Contraseña</span>
                    </button>
                    <button
                      className="user-menu-item"
                      onClick={() => { dispatch(setShowSubscriptionModal(true)); dispatch(setShowUserMenu(false)); }}
                    >
                      <CreditCard className="menu-icon" />
                      <span>Suscripción</span>
                    </button>
                    <button className="user-menu-item logout" onClick={handleLogout}>
                      <LogOut className="menu-icon" />
                      <span>Cerrar Sesión</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {token && (
              <div className="settings-menu-container">
                <button
                  className={`icon-btn settings-btn ${showSettingsMenu ? 'active' : ''}`}
                  onClick={handleToggleSettingsMenu}
                  title="Configuración"
                >
                  <Settings />
                </button>
                {showSettingsMenu && (
                  <div className="user-menu-dropdown settings-menu-dropdown">
                    <button className="user-menu-item" onClick={handleInstallWorker}>
                      <Download className="menu-icon" />
                      <span>Instalar worker</span>
                    </button>
                    <button className="user-menu-item" onClick={handleFullscreenToggle}>
                      {isFullscreen ? <Minimize2 className="menu-icon" /> : <Maximize2 className="menu-icon" />}
                      <span>{isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}</span>
                    </button>
                    <button
                      className="user-menu-item"
                      onClick={handleInstallPWA}
                      disabled={!installPromptAvailable}
                    >
                      <Smartphone className="menu-icon" />
                      <span>{installPromptAvailable ? 'Instalar PWA' : 'PWA no disponible'}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
