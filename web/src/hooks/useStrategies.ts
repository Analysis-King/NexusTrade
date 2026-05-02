import { useQuery } from '@tanstack/react-query';
import { strategiesApi } from '@/api/endpoints';

export function useStrategies() {
  return useQuery({
    queryKey: ['strategies'],
    queryFn: () => strategiesApi.list(),
    staleTime: 30_000,
  });
}
