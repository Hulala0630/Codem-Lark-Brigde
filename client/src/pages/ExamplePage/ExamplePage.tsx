// import { useState } from 'react';
// import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
// import { Button } from '@/components/ui/button';
// import { RefreshCw, TrendingUp, PieChart, Clock } from 'lucide-react';
// import { Link } from 'react-router-dom';
// import { useRecordList } from '@/hooks/use-example';
// import { getApiErrorMessage } from '@/lib/api-error';

// export default function ExamplePage() {
//   const { data: records, isLoading, isError, error, refetch } = useRecordList({ limit: 5 });
//   const [dimension, setDimension] = useState<'month' | 'quarter' | 'year'>('month');

//   if (isLoading) {
//     return (
//       <div className="flex items-center justify-center h-64">
//         <div className="text-muted-foreground">加载中...</div>
//       </div>
//     );
//   }

//   if (isError) {
//     return (
//       <div className="flex flex-col items-center justify-center h-64 space-y-4">
//         <div className="text-destructive">{getApiErrorMessage(error, '获取数据失败，请稍后重试')}</div>
//         <Button onClick={() => refetch()} variant="outline" size="sm">
//           <RefreshCw className="h-4 w-4 mr-2" />
//           重试
//         </Button>
//       </div>
//     );
//   }

//   return (
//     <div className="space-y-6">
//       {/* 页面内容，records 可能为空，渲染前检查 */}
//     </div>
//   );
// }