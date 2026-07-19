import { configureStore, combineReducers, type ThunkAction, type Action } from '@reduxjs/toolkit';
import { persistStore, persistReducer, FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER } from 'redux-persist';
import storage from 'redux-persist/lib/storage';

import authReducer, { clearAuth } from './slices/authSlice';
import connectionReducer from './slices/connectionSlice';
import workersReducer, { resetWorkersState } from './slices/workersSlice';
import sessionsReducer, { resetSessionsState } from './slices/sessionsSlice';
import uiReducer from './slices/uiSlice';
import commandsReducer, { resetCommandsState } from './slices/commandsSlice';
import agentsReducer, { resetAgentsState } from './slices/agentsSlice';
import { setConnectionState } from './slices/connectionSlice';

const rootReducer = combineReducers({
  auth: authReducer,
  connection: connectionReducer,
  workers: workersReducer,
  sessions: sessionsReducer,
  ui: uiReducer,
  commands: commandsReducer,
  agents: agentsReducer,
});

const persistConfig = {
  key: 'ultimate-terminal',
  version: 1,
  storage,
  whitelist: ['auth', 'sessions', 'workers', 'commands'],
  // Blacklist UI states that shouldn't persist across reloads
  blacklist: ['connection', 'ui'],
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});

export const persistor = persistStore(store);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export type AppThunk<ReturnType = void> = ThunkAction<ReturnType, RootState, unknown, Action<string>>;

export const logoutAndReset = (message?: string): AppThunk => (dispatch) => {
  dispatch(clearAuth(message));
  dispatch(resetSessionsState());
  dispatch(resetWorkersState());
  dispatch(resetCommandsState());
  dispatch(resetAgentsState());
  dispatch(setConnectionState('disconnected'));
  persistor.purge();
};

// Re-export all slice actions and selectors for easier imports
export * from './slices/authSlice';
export * from './slices/connectionSlice';
export * from './slices/workersSlice';
export * from './slices/sessionsSlice';
export * from './slices/uiSlice';
export * from './slices/commandsSlice';
export * from './slices/agentsSlice';
