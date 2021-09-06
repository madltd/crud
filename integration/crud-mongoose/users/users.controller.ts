import { Controller } from '@nestjs/common';
import { Crud, CrudController } from '@mfcsafe/crud';
import { User } from './user.entity';
import { UsersService } from './users.service';

@Crud({
  model: {
    type: User,
  },
  query: {
    limit: 10,
    maxLimit: 100,
    alwaysPaginate: true
  }
})
@Controller('users')
export class UsersController implements CrudController<User> {

  constructor(public service: UsersService) {
  }
}
