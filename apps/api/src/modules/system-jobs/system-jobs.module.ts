import { Module } from '@nestjs/common';
import { SystemJobsController } from './system-jobs.controller';
import { SystemJobsQueue } from './system-jobs.queue';
import { SystemJobsService } from './system-jobs.service';

@Module({
  controllers: [SystemJobsController],
  providers: [SystemJobsService, SystemJobsQueue],
})
export class SystemJobsModule {}
