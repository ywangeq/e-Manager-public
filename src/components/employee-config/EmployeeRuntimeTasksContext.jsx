import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const EmployeeRuntimeTasksContext = createContext(null);
const FIRST_PAGE_SIZE = 50;

function runtimeTasksEndpoint(employeeId, { limit = FIRST_PAGE_SIZE, offset = 0 } = {}) {
  if (!employeeId) return "";
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return `/api/digital-employees/${encodeURIComponent(employeeId)}/runtime-tasks?${query}`;
}

function mergeTaskPages(previous = {}, next = {}) {
  const byId = new Map();
  for (const task of Array.isArray(previous.tasks) ? previous.tasks : []) {
    if (task?.id) byId.set(task.id, task);
  }
  for (const task of Array.isArray(next.tasks) ? next.tasks : []) {
    if (task?.id) byId.set(task.id, task);
  }
  return {
    ...previous,
    ...next,
    tasks: Array.from(byId.values()),
  };
}

export function EmployeeRuntimeTasksProvider({ employeeId, children }) {
  const activeRequest = useRef(null);
  const [state, setState] = useState({ status: employeeId ? "loading" : "idle", data: null, error: "", isLoadingMore: false });

  const requestPage = useCallback(async ({ append = false, offset = 0 } = {}) => {
    if (!employeeId) return;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setState((current) => ({
      ...current,
      status: append ? current.status : "loading",
      error: "",
      isLoadingMore: append,
    }));
    try {
      const response = await fetch(runtimeTasksEndpoint(employeeId, { offset }), {
        credentials: "include",
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || "任务监控读取失败");
      if (activeRequest.current !== controller) return;
      setState((current) => ({
        status: "ready",
        data: append ? mergeTaskPages(current.data, data) : data,
        error: "",
        isLoadingMore: false,
      }));
    } catch (error) {
      if (error?.name === "AbortError" || activeRequest.current !== controller) return;
      setState((current) => ({
        ...current,
        status: "error",
        error: error.message || "任务监控读取失败",
        isLoadingMore: false,
      }));
    }
  }, [employeeId]);

  const refresh = useCallback(() => requestPage(), [requestPage]);
  const loadMore = useCallback(() => {
    if (state.isLoadingMore || !state.data?.page?.hasMore) return;
    return requestPage({ append: true, offset: Array.isArray(state.data.tasks) ? state.data.tasks.length : 0 });
  }, [requestPage, state.data?.page?.hasMore, state.data?.tasks, state.isLoadingMore]);
  const replaceTask = useCallback((nextTask = {}) => {
    if (!nextTask?.id) return;
    setState((current) => ({
      ...current,
      data: {
        ...(current.data || {}),
        tasks: replaceRuntimeTask(current.data?.tasks, nextTask),
      },
    }));
  }, []);

  useEffect(() => {
    void refresh();
    return () => activeRequest.current?.abort();
  }, [refresh]);

  return (
    <EmployeeRuntimeTasksContext.Provider value={{ state, refresh, loadMore, replaceTask }}>
      {children}
    </EmployeeRuntimeTasksContext.Provider>
  );
}

export function useEmployeeRuntimeTasks() {
  const context = useContext(EmployeeRuntimeTasksContext);
  if (!context) throw new Error("EmployeeRuntimeTasksProvider is required");
  return context;
}

function replaceRuntimeTask(tasks = [], nextTask = {}) {
  const rows = Array.isArray(tasks) ? tasks : [];
  if (!rows.some((task) => task.id === nextTask.id)) return [nextTask, ...rows];
  return rows.map((task) => task.id === nextTask.id
    ? { ...nextTask, ...(!nextTask.businessReference && task.businessReference ? { businessReference: task.businessReference } : {}) }
    : task);
}
