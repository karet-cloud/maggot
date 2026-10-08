import { useQuery } from "@tanstack/react-query";
import { api, keys } from "./api.ts";

export const useProjectTasks = (project: string) => useQuery({ queryKey: keys.tasks(project), queryFn: () => api.tasks(project) });
