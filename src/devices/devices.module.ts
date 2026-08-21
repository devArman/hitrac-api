import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { FuelWatcherService } from './fuel-watcher.service';
import { GeocodeService } from './geocode.service';
import { TowWatcherService } from './tow-watcher.service';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService, FuelWatcherService, TowWatcherService, GeocodeService],
  exports: [DevicesService],
})
export class DevicesModule {}
